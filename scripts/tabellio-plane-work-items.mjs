#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { assertNoSymlinkPath, pathState } from "./lib/output-safety.mjs";
import { collectPlaneWorkItemSnapshot } from "./lib/plane-work-item-collector.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseOptions();
  requireOptions(options, ["workspace", "out"], "collect");
  const token = requirePlaneToken();
  const out = resolve(options.out);
  await assertSafeOutput(out);
  const snapshot = await collectPlaneWorkItemSnapshot({
    workspace: options.workspace,
    request: (path) => planeRequest(path, token),
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: snapshot.status === "available",
    status: snapshot.status,
    projectCount: snapshot.projects.length,
    workItemCount: snapshot.workItems.length,
    out,
  }, null, 2));
  process.exitCode = snapshot.status === "available" ? 0 : 1;
}

function parseOptions() {
  return parseCommandOptions(process.argv.slice(2), {
    collect: ["workspace", "out"],
  });
}

function requirePlaneToken() {
  const token = process.env.PLANE_API_KEY;
  if (!token) throw new Error("PLANE_API_KEY is required at runtime.");
  return token;
}

async function assertSafeOutput(out) {
  await assertNoSymlinkPath(out, "--out");
  const outState = await pathState(out);
  if (outState?.symbolicLink) throw new Error("--out must not be a symbolic link.");
}

async function planeRequest(path, token) {
  const response = await fetch(`https://api.plane.so${path}`, {
    headers: { "X-API-Key": token },
  });
  if (!response.ok) throw new Error("Plane API request failed.");
  return response.json();
}
