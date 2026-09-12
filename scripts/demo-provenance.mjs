#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { LocalProvenanceStore } from "./lib/local-provenance-store.mjs";
import { captureCandidate } from "./lib/provenance-ledger.mjs";
import { sampleObservations } from "../examples/provenance/sample.mjs";
import { parseOptionPairs, writeJsonOutput } from "./lib/cli-options.mjs";

const execute = promisify(execFile);
const options = parseOptionPairs(process.argv.slice(2));
if (Object.keys(options).some((key) => !["out", "verifyStorageTests"].includes(key))) throw new Error("Unsupported demo option.");
if (options.verifyStorageTests !== undefined && options.verifyStorageTests !== "true") throw new Error("--verify-storage-tests accepts true.");
const startedAt = Date.now();
const root = await mkdtemp(join(tmpdir(), "tbl-"));
// Unix socket names have a small OS limit; validation TMPDIR can be much longer.
const socketRoot = await mkdtemp("/tmp/tbl-pg-");
const data = join(root, "data");
const repo = join(root, "repo");
let running = false;
let initialized = false;
let receipt;
const env = { ...process.env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Sample", GIT_AUTHOR_EMAIL: "sample@example.invalid", GIT_COMMITTER_NAME: "Sample", GIT_COMMITTER_EMAIL: "sample@example.invalid" };
for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
const run = (command, args, cwd = root) => execute(command, args, { cwd, env, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
const start = async () => {
  const socket = `'${socketRoot.replaceAll("'", "'\\''")}'`;
  await run("pg_ctl", ["-D", data, "-l", join(root, "postgres.log"), "-o", `-h '' -k ${socket}`, "-w", "start"]);
  running = true;
};
const stop = async () => {
  await run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  running = false;
};
try {
  await run("initdb", ["-D", data, "--auth=trust", "--username=tabellio", "--encoding=UTF8", "--no-locale"]);
  initialized = true;
  await start();
  await run("createdb", ["--host", socketRoot, "--username", "tabellio", "--no-password", "tabellio"]);
  if (options.verifyStorageTests === "true") {
    const testFile = fileURLToPath(new URL("../tests/local-provenance-store.test.mjs", import.meta.url));
    const lineageTests = fileURLToPath(new URL("../tests/provenance-ledger.test.mjs", import.meta.url));
    await execute(process.execPath, ["--test", testFile, lineageTests], {
      cwd: root, env: { ...env, TABELLIO_REQUIRE_POSTGRES: "1", TABELLIO_TEST_PG_SOCKET: socketRoot, TABELLIO_TEST_PG_USER: "tabellio" },
      timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    });
  }
  const databaseUrl = `postgresql://tabellio@localhost/tabellio?host=${encodeURIComponent(socketRoot)}`;
  await mkdir(repo);
  const git = (...args) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], repo);
  await git("init", "-b", "main");
  await writeFile(join(repo, "app.mjs"), "export const greeting = 'Hello';\n");
  await git("add", "app.mjs");
  await git("commit", "-m", "Create sample application");
  await git("checkout", "-b", "sample-change");
  await writeFile(join(repo, "app.mjs"), "export const greeting = 'Hello, Tabellio';\n");
  await git("add", "app.mjs");
  await git("commit", "-m", "Update sample greeting");
  const candidate = await captureCandidate({ repo, projectKey: "SAMPLE", repositoryId: "sample/repository" });
  const now = new Date().toISOString();
  const input = { candidate, observations: sampleObservations(candidate, now) };
  const inputPath = join(root, "input.json");
  await writeFile(inputPath, JSON.stringify(input));
  const cli = fileURLToPath(new URL("./tabellio-provenance.mjs", import.meta.url));
  const invoke = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args])).stdout);
  const imported = await invoke("import", "--database-url", databaseUrl, "--input", inputPath);
  const query = ["--database-url", databaseUrl, "--digest", imported.digest, "--project-key", "SAMPLE", "--repository-id", "sample/repository"];
  const reviewArgs = [...query, "--repo", repo, "--now", now];
  const initial = await invoke("review", ...reviewArgs);
  if (initial.status !== "passed") throw new Error("Sample review did not pass.");
  await stop();
  await start();
  const afterRestart = await invoke("show", ...query);
  if (afterRestart.digest !== imported.digest) throw new Error("Restart changed the lineage.");
  const store = new LocalProvenanceStore({ databaseUrl }); await store.migrate();
  await store.removeLineage({ digest: imported.digest, projectKey: "SAMPLE", repositoryId: "sample/repository" });
  const replayed = await invoke("replay", "--database-url", databaseUrl, "--input", inputPath);
  if (replayed.digest !== imported.digest) throw new Error("Replay changed the lineage.");
  const packet = await invoke("packet", ...reviewArgs);
  if (packet.status !== "passed" || packet.facts.length !== 8) throw new Error("Sample packet is incomplete.");
  await git("branch", "-f", "main", candidate.headCommit);
  let moved;
  try {
    await invoke("review", ...reviewArgs);
    throw new Error("Moved base incorrectly passed.");
  } catch (error) {
    if (error.code !== 1 || !error.stdout) throw error;
    moved = JSON.parse(error.stdout);
    if (moved.status !== "blocked" || !moved.reasons.some((reason) => reason.state === "stale")) throw new Error("Moved base did not block readiness.");
  }
  receipt = { status: "passed", candidate, lineageDigest: imported.digest, checks: { cliImport: "passed", review: initial.status, postgresServerRestart: "passed", deleteAndReplay: "passed", safePacket: packet.status, movedBase: moved.status }, sources: { git: "real temporary sample repository", plane: "synthetic fixture", entire: "synthetic fixture", github: "synthetic fixture", buildkite: "synthetic fixture", security: "synthetic fixture" }, cost: { usd: 0, modelCalls: 0, cloudCalls: 0 } };
} catch (error) {
  const postgresLog = await readFile(join(root, "postgres.log"), "utf8").catch(() => "");
  const socketPathFailure = /Unix-domain socket path.*too long/i.test(postgresLog);
  receipt = { status: "blocked", failureClass: socketPathFailure ? "socket_path_too_long" : "local_command_failed", exitCode: typeof error.code === "number" ? error.code : null, reason: "Sample demo failed. Requires local PostgreSQL server/client binaries and Git; no provider credentials are required." };
  process.exitCode = 1;
} finally {
  try {
    if (initialized && !running) {
      try {
        await run("pg_ctl", ["-D", data, "status"]);
        running = true;
      } catch (error) {
        if (error.code !== 3) throw error;
      }
    }
    if (running) await stop();
    await rm(root, { recursive: true, force: true });
    await rm(socketRoot, { recursive: true, force: true });
    receipt.cleanup = "passed";
  } catch {
    receipt.cleanup = "blocked";
    receipt.status = "blocked";
    receipt.recoveryDirectory = root;
    receipt.socketDirectory = socketRoot;
    process.exitCode = 1;
  }
  receipt.durationMs = Date.now() - startedAt;
  await writeJsonOutput(receipt, options.out);
}
