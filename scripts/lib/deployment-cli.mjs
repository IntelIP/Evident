import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function writeDeploymentCollection({ collector, input, out, provider }) {
  const result = await collector(input);
  const output = resolve(out);
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    ok: result.status === "available",
    status: result.status === "available" ? `${provider}_deployment_receipt_ready` : `${provider}_deployment_receipt_blocked`,
    out: output,
  }, null, 2));
  if (result.status !== "available") process.exitCode = 1;
}
