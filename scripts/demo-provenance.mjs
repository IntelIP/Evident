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
import { sampleSourceBundle } from "../examples/provenance/sources.mjs";
import { runSecurityReview, SECURITY_CHECKS } from "./lib/provenance-security.mjs";
import { SECURITY_POLICY_DIGEST } from "./lib/provenance-security-scanners.mjs";
import { publishProvenanceStatuses } from "./lib/provenance-review-publication.mjs";
import { GitHubStatusPublisher } from "./providers/github-status-publisher.mjs";
import { parseOptionPairs, writeJsonOutput } from "./lib/cli-options.mjs";

const execute = promisify(execFile);
const options = parseOptionPairs(process.argv.slice(2));
if (Object.keys(options).some((key) => !["out", "verifyStorageTests", "verifySecurityScanners", "gitleaks"].includes(key))) throw new Error("Unsupported demo option.");
if (options.verifyStorageTests !== undefined && options.verifyStorageTests !== "true") throw new Error("--verify-storage-tests accepts true.");
if (options.verifySecurityScanners !== undefined && options.verifySecurityScanners !== "true") throw new Error("--verify-security-scanners accepts true.");
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
  const sourceTests = fileURLToPath(new URL("../tests/provenance-sources.test.mjs", import.meta.url));
  const securityTests = fileURLToPath(new URL("../tests/provenance-security.test.mjs", import.meta.url));
  const scannerTests = fileURLToPath(new URL("../tests/provenance-security-scanners.test.mjs", import.meta.url));
  const resultTests = fileURLToPath(new URL("../tests/provenance-review-result.test.mjs", import.meta.url));
  const publicationTests = fileURLToPath(new URL("../tests/provenance-review-publication.test.mjs", import.meta.url));
  await execute(process.execPath, ["--test", testFile, lineageTests, sourceTests, securityTests, scannerTests, resultTests, publicationTests], {
      cwd: root, env: { ...env, TABELLIO_REQUIRE_POSTGRES: "1", TABELLIO_TEST_PG_SOCKET: socketRoot, TABELLIO_TEST_PG_USER: "tabellio" },
      timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    });
  }
  const databaseUrl = `postgresql://tabellio@localhost/tabellio?host=${encodeURIComponent(socketRoot)}`;
  await mkdir(repo);
  const git = (...args) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], repo);
  await git("init", "-b", "main");
  await git("remote", "add", "origin", "https://github.com/sample/repository.git");
  await writeFile(join(repo, "app.mjs"), "export const greeting = 'Hello';\n");
  await git("add", "app.mjs");
  await git("commit", "-m", "Create sample application");
  await git("checkout", "-b", "sample-change");
  await writeFile(join(repo, "app.mjs"), "export const greeting = 'Hello, Tabellio';\n");
  await git("add", "app.mjs");
  await git("commit", "-m", "Update sample greeting\n\nPlane-Work-Item: SAMPLE-1\nEntire-Checkpoint: abcdef123456");
  const candidate = await captureCandidate({ repo, projectKey: "SAMPLE", repositoryId: "sample/repository" });
  const now = new Date().toISOString();
  const input = { candidate, observations: sampleObservations(candidate, now) };
  const inputPath = join(root, "input.json");
  await writeFile(inputPath, JSON.stringify(input));
  const cli = fileURLToPath(new URL("./tabellio-provenance.mjs", import.meta.url));
  const invoke = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args])).stdout);
  const invokeBlocked = async (...args) => {
    try {
      await invoke(...args);
    } catch (error) {
      if (error.code !== 1 || !error.stdout) throw error;
      return JSON.parse(error.stdout);
    }
    throw new Error("Expected blocked CLI exit.");
  };
  const sourcePath = join(root, "sources.json");
  const sourceBundle = await sampleSourceBundle(candidate, now);
  await writeFile(sourcePath, JSON.stringify(sourceBundle));
  const sourceImport = await invoke("import-sources", "--repo", repo, "--database-url", databaseUrl, "--input", sourcePath, "--now", now);
  if (sourceImport.status !== "stored" || !sourceImport.sources.every((source) => source.status === "present")) throw new Error("Source fixture import failed.");
  const sourcePacket = await invokeBlocked("packet", "--repo", repo, "--database-url", databaseUrl, "--digest", sourceImport.lineage.digest, "--project-key", "SAMPLE", "--repository-id", "sample/repository", "--now", now);
  if (sourcePacket.status !== "blocked" || sourcePacket.reasons.length !== 1 || sourcePacket.reasons[0].kind !== "security") throw new Error("Source fixture must block only on missing independent security review.");
  // Synthetic readers exercise the real CLI/storage boundary, not scanner effectiveness.
  const policyDigest = options.verifySecurityScanners ? SECURITY_POLICY_DIGEST : "f".repeat(64);
  const securityChecks = Object.fromEntries(SECURITY_CHECKS.map((category) => [category, async ({ candidateId, packetDigest, policyDigest }) => ({ candidateId, packetDigest, policyDigest, status: "passed", findings: [] })]));
  const lineagePath = join(root, "source-lineage.json");
  await writeFile(lineagePath, JSON.stringify(sourceImport.lineage));
  const securityReview = options.verifySecurityScanners
    ? await invoke("security", "--repo", repo, "--input", lineagePath, "--now", now, "--gitleaks", options.gitleaks ?? "gitleaks")
    : await runSecurityReview({ lineage: sourceImport.lineage, now, policyDigest, checks: securityChecks });
  const securityPath = join(root, "security.json");
  await writeFile(securityPath, JSON.stringify(securityReview));
  const securityArgs = ["import-security", "--repo", repo, "--database-url", databaseUrl, "--digest", sourceImport.lineage.digest, "--project-key", "SAMPLE", "--repository-id", "sample/repository", "--now", now, "--policy-digest", policyDigest, "--input", securityPath];
  const securityImport = await invoke(...securityArgs);
  const securedPacket = await invoke("packet", "--repo", repo, "--database-url", databaseUrl, "--digest", securityImport.digest, "--project-key", "SAMPLE", "--repository-id", "sample/repository", "--now", now);
  if (securityImport.status !== "passed" || securedPacket.status !== "passed") throw new Error("Synthetic security receipt import failed.");
  const unavailableSecurity = await runSecurityReview({ lineage: sourceImport.lineage, now, policyDigest, checks: {} });
  await writeFile(securityPath, JSON.stringify(unavailableSecurity));
  const blockedSecurityImport = await invokeBlocked(...securityArgs);
  if (blockedSecurityImport.status !== "blocked") throw new Error("Missing security readers must block.");
  const imported = await invoke("import", "--database-url", databaseUrl, "--input", inputPath);
  const query = ["--database-url", databaseUrl, "--digest", imported.digest, "--project-key", "SAMPLE", "--repository-id", "sample/repository"];
  const reviewArgs = [...query, "--repo", repo, "--now", now];
  const initial = await invoke("review", ...reviewArgs);
  if (initial.status !== "passed") throw new Error("Sample review did not pass.");
  await stop();
  await start();
  const afterRestart = await invoke("show", ...query);
  if (afterRestart.digest !== imported.digest) throw new Error("Restart changed the lineage.");
  const statusIntent = await invoke("review-intent", ...reviewArgs);
  const statusPublication = await publishSampleStatuses({ repo, lineage: afterRestart, intent: statusIntent, cli: initial, now });
  const store = new LocalProvenanceStore({ databaseUrl }); await store.migrate();
  const sourceQuery = { digest: sourceImport.lineage.digest, projectKey: candidate.projectKey, repositoryId: candidate.repositoryId };
  await store.removeLineage(sourceQuery);
  if (await store.getLineage(sourceQuery) !== null) throw new Error("Source replay did not start from an empty derived record.");
  sourceBundle.snapshots = Object.fromEntries(Object.entries(sourceBundle.snapshots).reverse());
  await writeFile(sourcePath, JSON.stringify(sourceBundle));
  const replaySourceArgs = ["replay-sources", "--repo", repo, "--database-url", databaseUrl, "--input", sourcePath, "--now", now, "--expected-digest", sourceImport.lineage.digest];
  for (let replay = 0; replay < 2; replay += 1) {
    const rebuilt = await invoke(...replaySourceArgs);
    if (rebuilt.status !== "stored" || rebuilt.lineage.digest !== sourceImport.lineage.digest) throw new Error("Source replay changed the record.");
  }
  if (JSON.stringify(sourceBundle) !== await readFile(sourcePath, "utf8")) throw new Error("Replay modified original source snapshots.");
  sourceBundle.snapshots.github.reviews[0].state = "changes_requested";
  await writeFile(sourcePath, JSON.stringify(sourceBundle));
  const changedSource = await invokeBlocked(...replaySourceArgs);
  if (changedSource.status !== "blocked" || changedSource.lineage.digest === sourceQuery.digest) throw new Error("Changed source replay was accepted.");
  if (await store.getLineage({ ...sourceQuery, digest: changedSource.lineage.digest }) !== null) throw new Error("Rejected replay was persisted.");
  if ((await store.getLineage(sourceQuery))?.digest !== sourceQuery.digest) throw new Error("Rejected replay changed the original record.");
  sourceBundle.snapshots.github.reviews[0].state = "approved";
  await writeFile(sourcePath, JSON.stringify(sourceBundle));
  const unavailableGitArgs = [...replaySourceArgs];
  unavailableGitArgs[2] = join(root, "missing-repository");
  const unavailableGit = await invokeBlocked(...unavailableGitArgs);
  if (unavailableGit.status !== "blocked" || unavailableGit.sources.find((source) => source.source === "git")?.status !== "blocked" || !unavailableGit.sources.filter((source) => source.source !== "git").every((source) => source.status === "present")) throw new Error("Git outage discarded healthy source evidence.");
  delete sourceBundle.snapshots.entire;
  await writeFile(sourcePath, JSON.stringify(sourceBundle));
  const missingSource = await invokeBlocked(...replaySourceArgs);
  if (missingSource.status !== "blocked" || missingSource.sources.find((source) => source.source === "entire")?.status !== "blocked") throw new Error("Missing source replay was accepted.");
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
  receipt = { status: "passed", candidate, lineageDigest: imported.digest, checks: { cliImport: "passed", sourceImport: sourceImport.status, sourceReplay: "passed", changedSourceReplay: changedSource.status, missingSourceReplay: missingSource.status, gitOutage: unavailableGit.status, missingSecurity: sourcePacket.status, securityImport: securityImport.status, unavailableSecurityImport: blockedSecurityImport.status, review: initial.status, githubRepresentation: statusPublication.status, postgresServerRestart: "passed", deleteAndReplay: "passed", safePacket: packet.status, movedBase: moved.status }, sources: { git: "real temporary sample repository", plane: "synthetic fixture", entire: "synthetic fixture", github: "synthetic records and local fake status transport", buildkite: "synthetic fixture", security: options.verifySecurityScanners ? "real bounded scanners over immutable Git content" : "synthetic fixture" }, cost: { usd: 0, modelCalls: 0, cloudCalls: 0 } };
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

async function publishSampleStatuses({ repo, lineage, intent, cli, now }) {
  const requests = [];
  const publisher = new GitHubStatusPublisher({ token: "synthetic-local-demo", fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    return new Response(JSON.stringify({ ...body, id: requests.length, created_at: now }), { status: 201 });
  } });
  const approval = { schemaVersion: "tabellio-provenance-status-approval/v0.1", id: "sample-review-status", intentDigest: intent.integrity.digest, approved: true, approvedBy: "Synthetic demo", approvedAt: now, expiresAt: new Date(Date.parse(now) + 60000).toISOString(), reason: "Local fake GitHub transport only." };
  const publication = await publishProvenanceStatuses({ repo, lineage, intent, approval, publisher, now });
  if (publication.status !== "published" || requests.length !== 2) throw new Error("Sample status publication failed.");
  for (const [index, request] of requests.entries()) {
    const expected = cli.github[index];
    if (!request.url.endsWith(`/statuses/${expected.commit}`) || request.body.state !== expected.state || request.body.context !== expected.context || request.body.description !== expected.description || (request.body.target_url ?? null) !== expected.targetUrl) throw new Error("CLI and GitHub status differ.");
  }
  return publication;
}
