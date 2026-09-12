#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
try {
  await execute(process.execPath, ["--test", "tests/provenance-security.test.mjs", "tests/provenance-security-scanners.test.mjs"], {
    env: { ...process.env, TABELLIO_GITLEAKS: "gitleaks", TABELLIO_REQUIRE_SECURITY_SCANNERS: "1" },
    timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  await execute(process.execPath, ["scripts/demo-provenance.mjs", "--verify-security-scanners", "true", "--gitleaks", "gitleaks"], {
    timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  process.stdout.write("Security scanner fixtures and exact-candidate CLI/storage integration passed.\n");
} catch {
  // Child diagnostics may contain scanner matches. Keep them outside evidence.
  process.stderr.write("Security checks blocked or failed. Check pinned scanner and PostgreSQL availability, then run the security tests locally.\n");
  process.exitCode = 1;
}
