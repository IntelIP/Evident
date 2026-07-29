#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  parseCommandOptions,
  reportCliError,
  requireOptions,
} from "./lib/cli-options.mjs";
import { renderDeliveryReport } from "./lib/delivery-report.mjs";
import { assertOutputDistinctFromInputs } from "./lib/output-boundary.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), {
    render: ["snapshot", "cadence", "out"],
  });
  requireOptions(options, ["snapshot", "cadence", "out"], "render");
  await assertOutputDistinctFromInputs({
    output: options.out,
    inputs: [options.snapshot],
    message: "--out must not alias the input snapshot.",
  });
  const snapshot = JSON.parse(
    await readFile(resolve(options.snapshot), "utf8"),
  );
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${renderDeliveryReport(snapshot, { cadence: options.cadence })}\n`,
  );
  console.log(JSON.stringify({
    ok: true,
    status: "delivery_report_rendered",
    cadence: options.cadence,
    out,
  }, null, 2));
}
