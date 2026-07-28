import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assertNoSymlinkPath, pathState } from "./output-safety.mjs";

export async function writeDeploymentCollection({ collector, input, out, provider }) {
  const output = resolve(out);
  await assertNoSymlinkPath(output, "--out");
  const state = await pathState(output);
  if (state?.symbolicLink) throw new Error("--out must not be a symbolic link.");
  const result = await collector(input);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: result.status === "available",
    status: resultStatus(provider, result.status),
    out: output,
  }, null, 2));
  if (result.status !== "available") process.exitCode = 1;
}

function resultStatus(provider, status) {
  if (status === "available") return `${provider}_deployment_receipt_ready`;
  return `${provider}_deployment_receipt_blocked`;
}
