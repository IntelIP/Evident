import { normalizeRecord, boundedText, requiredString } from "./provenance-record.mjs";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";


const DEFAULT_PSQL_BINARY = process.env.TABELLIO_PSQL_BIN ?? "psql";
const DEFAULT_DATABASE_URL = process.env.TABELLIO_DATABASE_URL
  ?? "postgresql:///tabellio";
const DEFAULT_MIGRATION_PATH = fileURLToPath(new URL("../../migrations/001_tabellio_records.sql", import.meta.url));
export class LocalProvenanceStore {
  constructor({ databaseUrl = DEFAULT_DATABASE_URL, psqlBinary = DEFAULT_PSQL_BINARY, migrationPath = DEFAULT_MIGRATION_PATH } = {}) {
    this.databaseUrl = assertLocalDatabaseUrl(databaseUrl);
    this.psqlBinary = requiredString(psqlBinary, "psqlBinary");
    this.migrationPath = requiredString(migrationPath, "migrationPath");
  }


  async migrate() {
    const migration = await readFile(this.migrationPath, "utf8");
    await runPsql({
      databaseUrl: this.databaseUrl,
      psqlBinary: this.psqlBinary,
      sql: migration,
    });
    const lineageMigration = await readFile(new URL("../../migrations/002_tabellio_lineages.sql", import.meta.url), "utf8");
    await runPsql({ databaseUrl: this.databaseUrl, psqlBinary: this.psqlBinary, sql: lineageMigration });
    return { version: "002_tabellio_lineages" };
  }

  async putRecord(record) {
    const value = normalizeRecord(record);
    const variables = {};
    const columns = [
      "record_id", "entity_type", "entity_key", "project_key", "repository_id", "run_id",
      "commit_sha", "checkpoint_id", "pull_request_number", "validation_id", "source", "source_id",
      "observed_at", "status", "sensitivity", "payload", "payload_sha256",
    ];
    const values = [
      sqlParameter(value.recordId, variables),
      sqlParameter(value.entityType, variables),
      sqlParameter(value.entityKey, variables),
      sqlValue(value.projectKey, variables),
      sqlValue(value.repositoryId, variables),
      sqlValue(value.runId, variables),
      sqlValue(value.commitSha, variables),
      sqlValue(value.checkpointId, variables),
      sqlValue(value.pullRequestNumber, variables),
      sqlValue(value.validationId, variables),
      sqlParameter(value.source, variables),
      sqlParameter(value.sourceId, variables),
      `${sqlParameter(value.observedAt, variables)}::timestamptz`,
      sqlParameter(value.status, variables),
      sqlParameter(value.sensitivity, variables),
      `${sqlParameter(value.payloadJson, variables)}::jsonb`,
      sqlParameter(value.payloadSha256, variables),
    ].join(", ");
    const sql = `INSERT INTO tabellio_records (${columns.join(", ")})\nVALUES (${values})\nON CONFLICT (source, source_id) DO UPDATE SET\n  entity_type = EXCLUDED.entity_type,\n  entity_key = EXCLUDED.entity_key,\n  project_key = EXCLUDED.project_key,\n  repository_id = EXCLUDED.repository_id,\n  run_id = EXCLUDED.run_id,\n  commit_sha = EXCLUDED.commit_sha,\n  checkpoint_id = EXCLUDED.checkpoint_id,\n  pull_request_number = EXCLUDED.pull_request_number,\n  validation_id = EXCLUDED.validation_id,\n  observed_at = EXCLUDED.observed_at,\n  status = EXCLUDED.status,\n  sensitivity = EXCLUDED.sensitivity,\n  payload = EXCLUDED.payload,\n  payload_sha256 = EXCLUDED.payload_sha256,\n  updated_at = now();`;
    const output = await runPsql({
      databaseUrl: this.databaseUrl,
      psqlBinary: this.psqlBinary,
      sql: `WITH upserted AS (\n${sql.slice(0, -1)}\nRETURNING *)\n${recordJsonProjection("upserted")};`,
      variables,
      tuplesOnly: true,
    });
    return parseRecordOutput(output);
  }

  async getRecord({ source, sourceId }) {
    const normalizedSource = boundedText(source, "source");
    const normalizedSourceId = boundedText(sourceId, "sourceId");
    const variables = {};
    const sql = `${recordJsonProjection(
      "tabellio_records",
      `WHERE source = ${sqlParameter(normalizedSource, variables)} AND source_id = ${sqlParameter(normalizedSourceId, variables)}`,
    )};`;
    const output = await runPsql({
      databaseUrl: this.databaseUrl,
      psqlBinary: this.psqlBinary,
      sql,
      variables,
      tuplesOnly: true,
    });
    return parseRecordOutput(output);
  }

  async putLineage(input) {
    const { verifyLineage } = await import("./provenance-ledger.mjs");
    const lineage = verifyLineage(input);
    const variables = {};
    const envelope = sqlParameter(JSON.stringify(lineage), variables);
    const sql = `BEGIN;
      CREATE TEMP TABLE incoming_lineage ON COMMIT DROP AS SELECT ${envelope}::jsonb AS data;
      INSERT INTO tabellio_lineages (digest, candidate_id, project_key, repository_id, base_commit, head_commit, merge_base, envelope)
        SELECT data->>'digest', data->'candidate'->>'id', data->'candidate'->>'projectKey', data->'candidate'->>'repositoryId',
          data->'candidate'->>'baseCommit', data->'candidate'->>'headCommit', data->'candidate'->>'mergeBase', data
        FROM incoming_lineage ON CONFLICT DO NOTHING;
      INSERT INTO tabellio_observations (lineage_digest, observation_id, source, source_id, observed_at, kind, status, candidate_id, payload)
        SELECT data->>'digest', item->>'id', item->>'source', item->>'sourceId', (item->>'observedAt')::timestamptz,
          item->>'kind', item->>'status', item->'candidate'->>'id', item
        FROM incoming_lineage, jsonb_array_elements(data->'observations') item ON CONFLICT DO NOTHING;
      INSERT INTO tabellio_evidence_links (lineage_digest, observation_id, relation, target_source, target_source_id, basis)
        SELECT data->>'digest', item->>'id', link->>'relation', link->>'source', link->>'sourceId', link->>'basis'
        FROM incoming_lineage, jsonb_array_elements(data->'observations') item, jsonb_array_elements(item->'links') link
        ON CONFLICT DO NOTHING;
      COMMIT;`;
    await runPsql({ databaseUrl: this.databaseUrl, psqlBinary: this.psqlBinary, sql, variables });
    return lineage.digest;
  }

  async getLineage(query) {
    const { projectKey, repositoryId } = query;
    const variables = {};
    const sql = `SELECT envelope::text FROM tabellio_lineages WHERE ${lineageWhere(query, variables)};`;
    const result = await runPsql({ databaseUrl: this.databaseUrl, psqlBinary: this.psqlBinary, sql, variables, tuplesOnly: true });
    if (!result) return null;
    const { verifyLineage } = await import("./provenance-ledger.mjs");
    const lineage = verifyLineage(JSON.parse(result));
    if (lineage.candidate.projectKey !== projectKey || lineage.candidate.repositoryId !== repositoryId) throw new Error("Stored lineage scope integrity mismatch.");
    return lineage;
  }

  async removeLineage(query) {
    // Explicitly deletes only one derived snapshot; source systems are never touched.
    const variables = {};
    const sql = `DELETE FROM tabellio_lineages WHERE ${lineageWhere(query, variables)};`;
    await runPsql({ databaseUrl: this.databaseUrl, psqlBinary: this.psqlBinary, sql, variables });
  }

  async count() {
    const output = await runPsql({
      databaseUrl: this.databaseUrl,
      psqlBinary: this.psqlBinary,
      sql: "SELECT count(*)::bigint FROM tabellio_records;",
      tuplesOnly: true,
    });
    const value = Number(output);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Local PostgreSQL returned an invalid record count.");
    return value;
  }
}



function lineageWhere({ digest, projectKey, repositoryId }, variables) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Lineage digest is required.");
  return `digest = ${sqlParameter(digest, variables)}
    AND project_key = ${sqlParameter(boundedText(projectKey, "projectKey"), variables)}
    AND repository_id = ${sqlParameter(boundedText(repositoryId, "repositoryId"), variables)}`;
}

function assertLocalDatabaseUrl(databaseUrl) {
  const value = requiredString(databaseUrl, "databaseUrl");
  if (!/^postgres(?:ql)?:\/\//i.test(value)) {
    throw new Error("databaseUrl must use the postgres:// or postgresql:// scheme.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("databaseUrl must be a PostgreSQL URL using a local host or Unix socket.");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("databaseUrl must use the postgres:// or postgresql:// scheme.");
  }
  if (parsed.password !== "") {
    throw new Error("databaseUrl must not contain a password; use the local PostgreSQL credential store.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!isLocalHost(host)) {
    throw new Error("TAB-19 local storage accepts only a local PostgreSQL host or Unix socket.");
  }
  for (const entry of parsed.searchParams) validateConnectionParameter(entry);
  return value;
}

function validateConnectionParameter([rawKey, value]) {
  const key = rawKey.toLowerCase();
  if (["password", "sslpassword", "passfile"].includes(key)) throw new Error("databaseUrl must not contain password or credential-file parameters.");
  if (key === "dbname") throw new Error("databaseUrl must not override the database name through query parameters.");
  if (key === "service") throw new Error("TAB-19 local storage does not accept PostgreSQL service profiles.");
  if (!["host", "hostaddr"].includes(key)) return;
  const hosts = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (hosts.some((host) => !isLocalHost(host) && !host.startsWith("/"))) throw new Error("TAB-19 local storage accepts only a local PostgreSQL host or Unix socket.");
}

async function runPsql({ databaseUrl, psqlBinary, sql, variables = {}, tuplesOnly = false }) {
  const args = ["--no-psqlrc", "--no-password", "--quiet", "--set=ON_ERROR_STOP=1"];
  if (tuplesOnly) args.push("--tuples-only", "--no-align");
  args.push("--dbname", databaseUrl);
  try {
    const childEnvironment = {
      ...process.env,
      LC_ALL: "C",
      NO_COLOR: "1",
      PGAPPNAME: "tabellio-local-store",
      PGCLIENTENCODING: "UTF8",
      PGCONNECT_TIMEOUT: "5",
    };
    for (const key of ["PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE", "PGPASSWORD", "PGPASSFILE", "PGPORT", "PGOPTIONS"]) {
      delete childEnvironment[key];
    }
    childEnvironment.PGOPTIONS = "-c statement_timeout=10000 -c lock_timeout=3000";
    const child = spawn(psqlBinary, args, {
      env: childEnvironment, stdio: ["pipe", "pipe", "pipe"], timeout: 15000, killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    const result = await new Promise((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > 64 * 1024) child.kill("SIGKILL");
      });
      child.once("error", reject);
      child.stdin.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
      const variablesInput = Object.entries(variables)
        .map(([name, value]) => `\\set ${name} ${value}`)
        .join("\n");
      child.stdin.end(`${variablesInput}${variablesInput === "" ? "" : "\n"}${sql}\n`);
    });
    if (result.code !== 0) {
      // PostgreSQL errors can echo submitted data. Only expose the failure class.
      const reason = /timeout/i.test(stderr) ? "timeout" : result.signal ? "terminated" : "query rejected";
      throw new Error(`${reason} (exit ${result.code ?? result.signal})`);
    }
    return stdout.trim();
  } catch (error) {
    const detail = redactDatabaseUrl(error.stderr || error.message || "unknown error", databaseUrl).trim();
    throw new Error(`Local PostgreSQL command failed: ${detail}`);
  }
}

function sqlValue(value, variables) {
  if (value === null) return "NULL";
  const parameter = sqlParameter(value, variables);
  return typeof value === "number" ? `${parameter}::integer` : parameter;
}

function sqlParameter(value, variables) {
  const name = `tabellio_param_${Object.keys(variables).length}`;
  variables[name] = Buffer.from(String(value), "utf8").toString("base64");
  return `convert_from(decode(:'${name}', 'base64'), 'UTF8')`;
}

function redactDatabaseUrl(value, databaseUrl) {
  return String(value).replaceAll(databaseUrl, "[redacted database URL]").replace(/(postgres(?:ql)?:\/\/[^\s]+)/gi, "[redacted postgres URL]");
}

function recordJsonProjection(tableName, whereClause = "") {
  return `SELECT row_to_json(record)::text\nFROM (\n  SELECT\n    record_id AS "recordId",\n    entity_type AS "entityType",\n    entity_key AS "entityKey",\n    project_key AS "projectKey",\n    repository_id AS "repositoryId",\n    run_id AS "runId",\n    commit_sha AS "commitSha",\n    checkpoint_id AS "checkpointId",\n    pull_request_number AS "pullRequestNumber",\n    validation_id AS "validationId",\n    source,\n    source_id AS "sourceId",\n    to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "observedAt",\n    status,\n    sensitivity,\n    payload,\n    payload_sha256 AS "payloadSha256",\n    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",\n    to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"\n  FROM ${tableName}\n  ${whereClause}\n) AS record`;
}

function parseRecordOutput(output) {
  if (output === "") return null;
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Local PostgreSQL returned invalid record JSON: ${error.message}`);
  }
}



























function isLocalHost(value) {
  const host = String(value).replace(/^\[|\]$/g, "").toLowerCase();
  return host === "" || host === "localhost" || host === "::1" || host === "127.0.0.1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}
