#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { parseCommandOptions, reportCliError, requireOptions, writeJsonOutput } from "./lib/cli-options.mjs";
import { LocalProvenanceStore } from "./lib/local-provenance-store.mjs";

main().catch(reportCliError);

async function main() {
  const options = parseCommandOptions(process.argv.slice(2), {
    migrate: ["databaseUrl", "psql", "migration"],
    put: ["record", "databaseUrl", "psql", "migration"],
    get: ["source", "sourceId", "databaseUrl", "psql", "migration"],
    count: ["databaseUrl", "psql", "migration"],
  });
  if (options.command === "put") requireOptions(options, ["record"], "put");
  if (options.command === "get") requireOptions(options, ["source", "sourceId"], "get");

  const store = new LocalProvenanceStore({
    databaseUrl: options.databaseUrl,
    psqlBinary: options.psql,
    migrationPath: options.migration,
  }); await store.migrate();

  if (options.command === "migrate") {
    await writeJsonOutput({ ok: true, status: "migrated", version: "001_tabellio_records" });
    return;
  }
  if (options.command === "count") {
    await writeJsonOutput({ ok: true, count: await store.count() });
    return;
  }
  if (options.command === "get") {
    await writeJsonOutput({
      ok: true,
      record: await store.getRecord({ source: options.source, sourceId: options.sourceId }),
    });
    return;
  }

  const record = await readJson(options.record);
  await writeJsonOutput({ ok: true, record: await store.putRecord(record) });
}

async function readJson(path) {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`--record must contain valid JSON: ${error.message}`);
  }
}
