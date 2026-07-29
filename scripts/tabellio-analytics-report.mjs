#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { renderAnalyticsBaselineReport } from "./lib/analytics-report.mjs";
import {
  parseCommandOptions,
  reportCliError,
  requireOptions,
} from "./lib/cli-options.mjs";
import { assertOutputDistinctFromInputs } from "./lib/output-boundary.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), {
    render: ["dataset", "out"],
  });
  requireOptions(options, ["dataset", "out"], "render");
  await assertOutputDistinctFromInputs({
    output: options.out,
    inputs: [options.dataset],
    message: "--out must not alias the analytics dataset.",
  });
  const dataset = JSON.parse(await readFile(resolve(options.dataset), "utf8"));
  const out = resolve(options.out);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, renderAnalyticsBaselineReport(dataset));
  console.log(JSON.stringify({
    ok: true,
    status: "analytics_report_rendered",
    digest: dataset.integrity.digest,
    out,
  }, null, 2));
}
