#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function assertPlainObject(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
}

function normalizePosition(position, context) {
  assertPlainObject(position, context);
  if (!Number.isInteger(position.line) || position.line < 1) {
    throw new Error(`${context}.line must be a positive integer.`);
  }
  if (!Number.isInteger(position.column) || position.column < -1) {
    throw new Error(`${context}.column must be an integer greater than or equal to -1.`);
  }
  if (position.column === -1) {
    position.column = 0;
    return 1;
  }
  return 0;
}

function normalizeLocation(location, context) {
  assertPlainObject(location, context);
  return normalizePosition(location.start, `${context}.start`) + normalizePosition(location.end, `${context}.end`);
}

function normalizeMapLocations(map, context, key) {
  assertPlainObject(map, context);
  let replacements = 0;
  for (const [id, item] of Object.entries(map)) {
    assertPlainObject(item, `${context}.${id}`);
    if (key === "statementMap") {
      replacements += normalizeLocation(item, `${context}.${id}`);
      continue;
    }
    replacements += normalizeLocation(item.loc, `${context}.${id}.loc`);
    if (key === "branchMap") {
      if (!Array.isArray(item.locations)) {
        throw new Error(`${context}.${id}.locations must be an array.`);
      }
      for (const [index, location] of item.locations.entries()) {
        replacements += normalizeLocation(location, `${context}.${id}.locations.${index}`);
      }
    }
    if (key === "fnMap") {
      replacements += normalizeLocation(item.decl, `${context}.${id}.decl`);
    }
  }
  return replacements;
}

export function normalizeIstanbulCoverage(coverage) {
  assertPlainObject(coverage, "coverage");
  let replacements = 0;
  for (const [file, fileCoverage] of Object.entries(coverage)) {
    assertPlainObject(fileCoverage, `coverage.${file}`);
    replacements += normalizeMapLocations(fileCoverage.statementMap, `coverage.${file}.statementMap`, "statementMap");
    replacements += normalizeMapLocations(fileCoverage.fnMap, `coverage.${file}.fnMap`, "fnMap");
    replacements += normalizeMapLocations(fileCoverage.branchMap, `coverage.${file}.branchMap`, "branchMap");
  }
  return replacements;
}

async function main(args) {
  if (args.length !== 2) {
    throw new Error("Usage: normalize-istanbul-coverage.mjs <input> <output>");
  }
  const [input, output] = args.map((path) => resolve(path));
  const coverage = JSON.parse(await readFile(input, "utf8"));
  const replacements = normalizeIstanbulCoverage(coverage);
  await mkdir(dirname(output), { recursive: true });
  const temporaryOutput = `${output}.tmp-${process.pid}`;
  await writeFile(temporaryOutput, `${JSON.stringify(coverage)}\n`, "utf8");
  await rename(temporaryOutput, output);
  process.stdout.write(`${JSON.stringify({ input, output, normalizedColumns: replacements })}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
