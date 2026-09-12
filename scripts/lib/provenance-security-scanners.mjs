import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { captureCandidate } from "./provenance-ledger.mjs";
import { runSecurityReview } from "./provenance-security.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const RULES = [
  { id: "authorization-jwt-decode", pattern: "jwt.decode($TOKEN)" },
  { id: "authorization-jwt-decode-options", pattern: "jwt.decode($TOKEN, $$$REST)" },
  { id: "authorization-unsigned-jwt", pattern: { context: "({algorithms: ['none']})", selector: "pair" } },
  { id: "trust-disabled-tls", pattern: { context: "({rejectUnauthorized: false})", selector: "pair" } },
  { id: "trust-dynamic-eval", pattern: "eval($EXPRESSION)" },
];
const POLICY = {
  schemaVersion: "tabellio-security-policy/v0.1",
  gitleaksVersion: "8.30.1",
  astGrepVersion: "0.45.1",
  rules: RULES,
  dependencyPolicy: "Reject insecure HTTP dependencies. Other declared dependencies need separate vulnerability evidence and remain blocked.",
  scope: "Tracked regular files; Gitleaks default rules; listed JavaScript and TypeScript syntax rules. This is bounded deterministic analysis, not proof that all security defects are absent.",
};
export const SECURITY_POLICY_DIGEST = hash(JSON.stringify(POLICY));

function execute(command, args, { cwd, signal, binary = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      cwd, signal, encoding: binary ? "buffer" : "utf8", timeout: 240000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    }, (error, stdout) => {
      if (error && error.code !== 1) return reject(new Error("Security tool unavailable or incomplete."));
      resolvePromise({ exitCode: error ? 1 : 0, stdout });
    });
  });
}

async function snapshot(repo, candidate, directory) {
  const result = await execute("git", ["ls-tree", "-r", "-z", candidate.headCommit], { cwd: repo });
  if (result.exitCode !== 0) throw new Error("Candidate tree unavailable.");
  const files = new Map();
  let totalBytes = 0;
  for (const row of result.stdout.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/s.exec(row);
    if (!match) throw new Error("Unsupported candidate file mode.");
    const path = match[3];
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe candidate path.");
    const blob = await execute("git", ["cat-file", "blob", match[2]], { cwd: repo, binary: true });
    if (blob.exitCode !== 0) throw new Error("Candidate blob unavailable.");
    totalBytes += blob.stdout.length;
    if (files.size >= 4096 || totalBytes > 32 * 1024 * 1024) throw new Error("Candidate exceeds security scan bounds.");
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, blob.stdout, { mode: 0o600 });
    files.set(path, { digest: hash(blob.stdout), bytes: blob.stdout });
  }
  return files;
}

function locatedFinding(files, directory, path, line, ruleId, severity) {
  const scoped = relative(directory, resolve(directory, path));
  const file = files.get(scoped);
  if (!file) throw new Error("Finding is outside the immutable candidate.");
  return { ruleId, severity, path: scoped, line, evidenceDigest: file.digest };
}

async function scanSecrets(context, input) {
  const { directory, root, files, gitleaks } = context;
  const version = await execute(gitleaks, ["version"], { signal: input.signal, cwd: root });
  if (version.exitCode !== 0 || version.stdout.trim() !== POLICY.gitleaksVersion) throw new Error("Unexpected secret scanner version.");
  const config = join(root, "gitleaks.toml");
  const ignore = join(root, "gitleaks.ignore");
  const report = join(root, "secrets.json");
  await writeFile(config, "[extend]\nuseDefault = true\n", { mode: 0o600 });
  await writeFile(ignore, "", { mode: 0o600 });
  const result = await execute(gitleaks, ["dir", directory, "--config", config, "--gitleaks-ignore-path", ignore, "--report-format", "json", "--report-path", report, "--redact=100", "--ignore-gitleaks-allow", "--no-banner"], { signal: input.signal, cwd: root });
  const findings = JSON.parse(await readFile(report, "utf8"));
  if (!Array.isArray(findings) || (result.exitCode === 1 && findings.length === 0)) throw new Error("Incomplete secret scan.");
  return { ...input, status: findings.length ? "failed" : "passed", findings: findings.map((item) => locatedFinding(files, directory, item.File, item.StartLine, item.RuleID, "critical")) };
}

async function scanSyntax(context, input, category) {
  // Candidate comments cannot turn required checks off.
  for (const file of context.files.values()) {
    if (/^\s*(?:\/\/|\/\*|\*)\s*ast-grep-ignore\b/m.test(file.bytes.toString("utf8"))) return { ...input, status: "blocked", findings: [] };
  }
  const version = await execute(context.astGrep, ["--version"], { signal: input.signal, cwd: context.root });
  if (version.exitCode !== 0 || version.stdout.trim() !== `ast-grep ${POLICY.astGrepVersion}`) throw new Error("Unexpected syntax scanner version.");
  const rules = RULES.filter((rule) => rule.id.startsWith(category)).flatMap((rule) => ["JavaScript", "TypeScript", "Tsx"].map((language) => ({ id: `${rule.id}-${language.toLowerCase()}`, language, severity: "error", message: rule.id, rule: { pattern: rule.pattern } })));
  const args = ["scan", "--inline-rules", rules.map((rule) => JSON.stringify(rule)).join("\n---\n"), "--json=compact"];
  for (const kind of ["hidden", "dot", "exclude", "global", "parent", "vcs"]) args.push("--no-ignore", kind);
  args.push(context.directory);
  const result = await execute(context.astGrep, args, { signal: input.signal, cwd: context.root });
  const findings = JSON.parse(result.stdout);
  if (!Array.isArray(findings) || (result.exitCode === 1 && findings.length === 0)) throw new Error("Incomplete syntax scan.");
  return { ...input, status: findings.length ? "failed" : "passed", findings: findings.map((item) => locatedFinding(context.files, context.directory, item.file, item.range.start.line + 1, item.ruleId, "high")) };
}

function dependencyVersions(bytes) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  return ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap((key) => dependencyGroup(manifest, key));
}

function dependencyGroup(manifest, key) {
  const dependencies = manifest[key] ?? {};
  if (typeof dependencies !== "object" || Array.isArray(dependencies)) throw new Error("Malformed dependencies.");
  const versions = Object.values(dependencies);
  if (versions.some((version) => typeof version !== "string")) throw new Error("Malformed dependency version.");
  return versions;
}

function scanDependencies(context, input) {
  const declarations = [...context.files].filter(([path]) => path === "package.json" || path.endsWith("/package.json"))
    .flatMap(([path, file]) => dependencyVersions(file.bytes).map((version) => ({ path, file, version })));
  const findings = declarations.filter(({ version }) => /^(?:git\+)?http:\/\//i.test(version))
    .map(({ path, file }) => ({ ruleId: "dependencies-insecure-http", severity: "high", path, line: 1, evidenceDigest: file.digest }));
  return { ...input, status: findings.length ? "failed" : declarations.length ? "blocked" : "passed", findings };
}

export async function scanCandidateSecurity({ repo, lineage, now, base = "main", head = "HEAD", gitleaks = "gitleaks", astGrep = "ast-grep" }) {
  const candidate = await captureCandidate({ repo, projectKey: lineage.candidate.projectKey, repositoryId: lineage.candidate.repositoryId, base, head });
  if (candidate.id !== lineage.candidate.id) throw new Error("Security candidate changed.");
  const root = await mkdtemp(join(tmpdir(), "tabellio-security-"));
  try {
    const directory = join(root, "candidate");
    await mkdir(directory);
    const files = await snapshot(repo, candidate, directory);
    const context = { root, directory, files, gitleaks, astGrep };
    return await runSecurityReview({ lineage, now, policyDigest: SECURITY_POLICY_DIGEST, checks: {
      secrets: (input) => scanSecrets(context, input),
      authorization: (input) => scanSyntax(context, input, "authorization"),
      trust: (input) => scanSyntax(context, input, "trust"),
      dependencies: (input) => scanDependencies(context, input),
    } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
