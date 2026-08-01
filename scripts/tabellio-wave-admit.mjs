#!/usr/bin/env node

import {readFile, realpath} from "node:fs/promises";
import {isAbsolute, relative, resolve} from "node:path";

import {admitWave} from "./lib/wave-admission.mjs";

try {
  const options = parseOptions(process.argv.slice(2));
  const root = await realpath(process.cwd());
  const manifestPath = await containedPath(root, options.manifest, "manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const report = admitWave(manifest);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.decision !== "accepted") process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}

function parseOptions(args) {
  if (args.length !== 2 || args[0] !== "--manifest" || !args[1]) {
    throw new Error("Usage: tabellio-wave-admit --manifest <repository-relative-json>");
  }
  return {manifest: args[1]};
}

async function containedPath(root, input, label) {
  if (isAbsolute(input)) throw new Error(`${label} must be repository-relative.`);
  const lexicalTarget = resolve(root, input);
  const lexicalRel = relative(root, lexicalTarget);
  const lexicalEscape = [lexicalRel === "", lexicalRel.startsWith(".."), isAbsolute(lexicalRel)].includes(true);
  if (lexicalEscape) throw new Error(`${label} must stay inside the repository.`);
  const target = await realpath(lexicalTarget);
  const rel = relative(root, target);
  const escapesRepository = [rel === "", rel.startsWith(".."), isAbsolute(rel)].includes(true);
  if (escapesRepository) throw new Error(`${label} must stay inside the repository.`);
  return target;
}
