#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCommandOptions, reportCliError, requireOptions } from "./lib/cli-options.mjs";
import { renderDeliveryReport } from "./lib/delivery-report.mjs";
import { assertOutputBoundary } from "./lib/output-boundary.mjs";
main().catch(reportCliError);
async function main() {
  const options=parseCommandOptions(process.argv.slice(2),{render:["snapshot","cadence","out"]});
  requireOptions(options,["snapshot","cadence","out"],"render");
  await assertOutputBoundary({
    outputs: [options.out],
    protectedInputs: [options.snapshot],
    duplicatePathMessage: "--out must identify one output path.",
    symbolicLinkMessage: "--out must not be a symbolic link.",
    outputAliasMessage: "--out must identify one output file.",
    inputAliasMessage: "--out must not alias the input snapshot.",
    protectedRootMessage: "--out must not be inside a protected input root.",
  });
  const snapshot=JSON.parse(await readFile(resolve(options.snapshot),"utf8"));
  const out=resolve(options.out);
  await writeFile(out,`${renderDeliveryReport(snapshot,{cadence:options.cadence})}\n`);
  console.log(JSON.stringify({ok:true,cadence:options.cadence,out},null,2));
}
