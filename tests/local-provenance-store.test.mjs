import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { LocalProvenanceStore } from "../scripts/lib/local-provenance-store.mjs";
import { normalizeRecord } from "../scripts/lib/provenance-record.mjs";
import { assembleLineage, candidateIdentity, evaluateLineage } from "../scripts/lib/provenance-ledger.mjs";
import { sampleObservations } from "../examples/provenance/sample.mjs";

const execFileAsync = promisify(execFile);
const postgresHost = process.env.TABELLIO_TEST_PG_SOCKET ?? "127.0.0.1";
const postgresUser = process.env.TABELLIO_TEST_PG_USER;
const postgresArgs = ["--host", postgresHost, ...(postgresUser ? ["--username", postgresUser] : [])];
function testDatabaseUrl(name) {
  return `postgresql://${postgresUser ? `${encodeURIComponent(postgresUser)}@` : ""}localhost/${name}?host=${encodeURIComponent(postgresHost)}`;
}
const postgresAvailable = await canUsePostgres();

test("required PostgreSQL integration environment is available", () => {
  if (process.env.TABELLIO_REQUIRE_POSTGRES === "1") assert.ok(postgresAvailable, "Local PostgreSQL with CREATEDB permission is required; integration evidence cannot be skipped.");
});

test("lineage persists atomically, isolates projects, and replays from original fixtures", { skip: !postgresAvailable }, async (t) => {
  const databaseName = await createTestDatabase(t);
  const databaseUrl = testDatabaseUrl(databaseName);
  const store = new LocalProvenanceStore({ databaseUrl }); await store.migrate();
  const candidate = candidateIdentity({ projectKey: "SAMPLE", repositoryId: "sample/repository", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBase: "a".repeat(40) });
  const observations = sampleObservations(candidate);
  const lineage = assembleLineage({ candidate, observations });
  const query = { digest: lineage.digest, projectKey: candidate.projectKey, repositoryId: candidate.repositoryId };
  await store.putLineage(lineage);
  await store.putLineage(assembleLineage({ candidate, observations: [...observations].reverse() }));
  assert.deepEqual(await store.getLineage(query), lineage);
  assert.equal(await store.getLineage({ ...query, projectKey: "OTHER" }), null);
  const reconnected = new LocalProvenanceStore({ databaseUrl }); await reconnected.migrate();
  assert.deepEqual(await reconnected.getLineage(query), lineage);
  await reconnected.removeLineage(query);
  assert.equal(await reconnected.getLineage(query), null);
  await reconnected.putLineage(assembleLineage({ candidate, observations }));
  assert.deepEqual(await reconnected.getLineage(query), lineage);
  assert.equal(evaluateLineage(await reconnected.getLineage(query), { now: "2026-09-12T12:00:01Z" }).status, "passed");
  await adminCommand("psql", ["--dbname", databaseName, "--command", "UPDATE tabellio_lineages SET envelope = jsonb_set(envelope, '{candidate,headCommit}', '\"cccccccccccccccccccccccccccccccccccccccc\"')"]);
  await assert.rejects(() => reconnected.getLineage(query), /integrity/);
});

test("local provenance enforces metadata boundaries without PostgreSQL", function metadataBoundary() {
  const record = syntheticRecord();
  assert.throws(
    () => normalizeRecord({ ...record, payload: { apiKey: "synthetic-no-secret" } }),
    /forbidden field/,
  );
  assert.throws(
    () => normalizeRecord({ ...record, sensitivity: "secret" }),
    /sensitivity must be one of/,
  );
  assert.throws(
    () => normalizeRecord({ ...record, payload: [] }),
    /payload must be an object/,
  );
  const oversized = { refs: Array.from({ length: 600 }, (_, index) => index) };
  assert.throws(
    () => normalizeRecord({ ...record, payload: oversized }),
    /exceeds 512 values/,
  );
  for (const payload of [
    { transcript: "raw" },
    { providerResponse: { body: "raw" } },
    { toolRequest: { body: "raw" } },
    { mcpRequest: { body: "raw" } },
    { agentMcpRequest: { body: "raw" } },
    { environment: { HOME: "/synthetic" } },
    { apikey: "synthetic" },
    { credentials: "synthetic" },
    { "api-key": "synthetic" },
    { "access-token": "synthetic" },
    { "private-key": "synthetic" },
    { "prompt-text": "raw" },
    { promptText: "raw" },
    { modelPrompt: "raw" },
    { environmentVariables: { HOME: "/synthetic" } },
    { providerResponseBody: { body: "raw" } },
    { APIKey: "synthetic" },
    { MCPRequest: "raw" },
    { note: "password=synthetic-secret" },
    { value: "ghp_syntheticcredentialvalue" },
    { note: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.signature" },
    { note: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" },
  ]) {
    assert.throws(() => normalizeRecord({ ...record, payload }), /forbidden|unapproved|sensitive value/);
  }
  assert.throws(
    () => normalizeRecord({ ...record, payload: { unknownMetadata: "not in the envelope" } }),
    /unapproved field/,
  );
  assert.throws(
    () => normalizeRecord({ ...record, sensitivity: "public", checkpointId: null, payload: { checkpoint_id: "abcdef123456" } }),
    /payload checkpoint reference requires private sensitivity/,
  );
  for (const refs of [["0123456789ab"], ["01ARZ3NDEKTSV4RRFFQ69G5FAV"]]) {
    assert.throws(
      () => normalizeRecord({ ...record, sensitivity: "public", checkpointId: null, payload: { refs } }),
      /payload checkpoint reference requires private sensitivity/,
    );
  }
  assert.throws(
    () => normalizeRecord({ ...record, sensitivity: "public", checkpointId: null, sourceId: "0123456789ab" }),
    /payload checkpoint reference requires private sensitivity/,
  );
  assert.throws(
    () => normalizeRecord({ ...record, sensitivity: "public", checkpointId: null, payload: { links: ["https://example.invalid/checkpoints/0123456789ab"] } }),
    /payload checkpoint reference requires private sensitivity/,
  );
  assert.equal(
    normalizeRecord({ ...record, checkpointId: null, sensitivity: "private", payload: { checkpointId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } }).sensitivity,
    "private",
  );
  assert.equal(
    normalizeRecord({ ...record, checkpointId: "01arz3ndektsv4rrffq69g5fav", sensitivity: "private" }).checkpointId,
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  );
  for (const checkpointId of ["not-a-checkpoint", null, {}, "8ARZ3NDEKTSV4RRFFQ69G5FAV"]) {
    assert.throws(
      () => normalizeRecord({ ...record, checkpointId: null, sensitivity: "private", payload: { checkpoint_id: checkpointId } }),
      /checkpoint.*(?:id|reference)/i,
    );
  }
  assert.throws(
    () => normalizeRecord({ ...record, payload: { note: "contains\u0000nul" } }),
    /unsupported PostgreSQL text/,
  );
  assert.throws(
    () => normalizeRecord({ ...record, sourceId: "contains\ud800surrogate" }),
    /unsupported PostgreSQL text/,
  );
  for (const pullRequestNumber of [0, 2_147_483_648]) {
    assert.throws(
      () => normalizeRecord({ ...record, pullRequestNumber }),
      /positive PostgreSQL integer/,
    );
  }
  assert.throws(
    () => normalizeRecord({ ...record, sourceId: "ghp_syntheticcredentialvalue" }),
    /sensitive value/,
  );
  assert.throws(
    () => normalizeRecord({ ...record, checkpointId: "0123456789ab", sensitivity: "internal" }),
    /checkpointId requires private sensitivity/,
  );
  assert.equal(
    normalizeRecord({ ...record, checkpointId: "0123456789ab", sensitivity: "private" }).sensitivity,
    "private",
  );
  assert.notEqual(
    normalizeRecord({ ...record, recordId: undefined, source: "a", sourceId: "b:c" }).recordId,
    normalizeRecord({ ...record, recordId: undefined, source: "a:b", sourceId: "c" }).recordId,
  );
});

test("local provenance store migrates, persists, restarts, and upserts metadata", { skip: postgresAvailable ? false : "local PostgreSQL is unavailable" }, async (t) => {
  const databaseName = await createTestDatabase(t);

  const databaseUrl = testDatabaseUrl(databaseName);
  const store = new LocalProvenanceStore({ databaseUrl }); await store.migrate();
  assert.equal(await store.count(), 0);
  await store.migrate();
  assert.equal(await store.count(), 0);

  const record = {
    recordId: "plane:TAB-19",
    entityType: "story",
    entityKey: "TAB-19",
    projectKey: "TAB",
    repositoryId: "IntelIP/Tabellio",
    runId: "synthetic-run-1",
    commitSha: "a".repeat(40),
    checkpointId: "0123456789ab",
    pullRequestNumber: 19,
    validationId: "validation-1",
    source: "plane",
    sourceId: "TAB-19",
    observedAt: "2026-09-02T12:00:00.000Z",
    status: "present",
    sensitivity: "private",
    payload: { z: "last", a: "first", refs: ["TAB-18", "TAB-20"] },
  };
  const inserted = await store.putRecord(record);
  assert.equal(inserted.recordId, record.recordId);
  assert.equal(inserted.source, record.source);
  assert.deepEqual(inserted.payload, record.payload);
  assert.equal(inserted.payloadSha256, normalizeRecord(record).payloadSha256);
  assert.match(inserted.observedAt, /Z$/);
  assert.match(inserted.createdAt, /Z$/);
  assert.match(inserted.updatedAt, /Z$/);
  assert.equal(await store.count(), 1);

  const quoted = await store.putRecord({
    ...record,
    recordId: "plane:quoted",
    source: "plane\\'safe",
    sourceId: "TAB-19-quoted",
    payload: { note: "\\'; SELECT 42 AS injected; -- café" },
  });
  assert.equal(quoted.source, "plane\\'safe");
  assert.equal(quoted.payload.note, "\\'; SELECT 42 AS injected; -- café");
  assert.equal(await store.count(), 2);

  const restarted = new LocalProvenanceStore({ databaseUrl }); await restarted.migrate();
  assert.deepEqual(await restarted.getRecord({ source: "plane", sourceId: "TAB-19" }), inserted);
  const duplicate = await restarted.putRecord({ ...record, payload: { refs: ["TAB-18", "TAB-20"], a: "first", z: "last" } });
  assert.deepEqual(duplicate.payload, inserted.payload);
  assert.equal(await restarted.count(), 2);

  const changedIdentity = await restarted.putRecord({
    ...record,
    recordId: "different-record-id",
    payload: { refs: ["TAB-18", "TAB-20"], a: "first", z: "last" },
  });
  assert.equal(changedIdentity.recordId, record.recordId);

  await assert.rejects(
    restarted.putRecord({ ...record, sourceId: "TAB-19-secret", payload: { apiKey: "synthetic-no-secret" } }),
    /forbidden field/,
  );
  await assert.rejects(
    restarted.putRecord({ ...record, sourceId: "TAB-19-invalid", sensitivity: "internal", checkpointId: "0123456789ab" }),
    /checkpointId requires private sensitivity/,
  );

  await adminCommand("dropdb", ["--maintenance-db", "postgres", databaseName]);
  await assert.rejects(store.count(), /Local PostgreSQL command failed/);
});

test("local provenance store rejects remote PostgreSQL URLs", () => {
  assert.throws(
    () => new LocalProvenanceStore({ databaseUrl: "postgresql://db.example.invalid/tabellio" }),
    /local PostgreSQL host or Unix socket/,
  );
  assert.throws(
    () => new LocalProvenanceStore({ databaseUrl: "postgresql://hudson:synthetic-password@localhost/tabellio" }),
    /must not contain a password/,
  );
  assert.throws(
    () => new LocalProvenanceStore({ databaseUrl: "postgresql:///tabellio?password=synthetic-password" }),
    /password or credential-file/,
  );
  assert.throws(
    () => new LocalProvenanceStore({ databaseUrl: "postgresql:///tabellio?host=db.example.invalid" }),
    /local PostgreSQL host or Unix socket/,
  );
  assert.throws(
    () => new LocalProvenanceStore({ databaseUrl: "postgresql:///tabellio?hostaddr=203.0.113.1" }),
    /local PostgreSQL host or Unix socket/,
  );
  assert.throws(
    () => new LocalProvenanceStore({ databaseUrl: "postgresql:///tabellio?service=remote" }),
    /does not accept PostgreSQL service profiles/,
  );
  assert.throws(
    () => new LocalProvenanceStore({ databaseUrl: "postgresql:///tabellio?passfile=/tmp/pgpass" }),
    /password or credential-file/,
  );
  assert.throws(
    () => new LocalProvenanceStore({ databaseUrl: "postgresql:///tabellio?PASSWORD=synthetic-password" }),
    /password or credential-file/,
  );
  assert.throws(
    () => new LocalProvenanceStore({ databaseUrl: "postgresql:///tabellio?dbname=postgresql%3A%2F%2F203.0.113.1%2Fpostgres" }),
    /must not override the database name/,
  );
});

test("local provenance store CLI returns a saved synthetic record", { skip: postgresAvailable ? false : "local PostgreSQL is unavailable" }, async (t) => {
  const databaseName = await createTestDatabase(t);
  const inputRoot = await mkdtemp(join(tmpdir(), "tabellio-local-cli-"));
  t.after(() => rm(inputRoot, { recursive: true, force: true }));

  const databaseUrl = testDatabaseUrl(databaseName);
  const recordPath = join(inputRoot, "record.json");
  await writeFile(recordPath, JSON.stringify({
    entityType: "story",
    entityKey: "TAB-19",
    source: "cli-fixture",
    sourceId: "synthetic-1",
    observedAt: "2026-09-02T12:00:00.000Z",
    payload: { note: "safe synthetic metadata" },
  }));
  const script = new URL("../scripts/tabellio-local-store.mjs", import.meta.url);
  const migrated = await cli(script, ["migrate", "--database-url", databaseUrl]);
  assert.equal(JSON.parse(migrated.stdout).status, "migrated");
  const put = await cli(script, ["put", "--database-url", databaseUrl, "--record", recordPath]);
  assert.equal(JSON.parse(put.stdout).record.sourceId, "synthetic-1");
  const get = await cli(script, ["get", "--database-url", databaseUrl, "--source", "cli-fixture", "--source-id", "synthetic-1"]);
  assert.equal(JSON.parse(get.stdout).record.entityKey, "TAB-19");
  const count = await cli(script, ["count", "--database-url", databaseUrl]);
  assert.equal(JSON.parse(count.stdout).count, 1);
});

async function createTestDatabase(t) {
  const name = `tabellio_test_${randomUUID().replaceAll("-", "")}`;
  await adminCommand("createdb", ["--maintenance-db", "postgres", name]);
  t.after(() => adminCommand("dropdb", ["--if-exists", "--maintenance-db", "postgres", name]));
  return name;
}

async function canUsePostgres() {
  try {
    await execFileAsync("pg_isready", postgresArgs, { encoding: "utf8", env: localEnvironment() });
    const capability = await adminCommand("psql", [
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--dbname",
      "postgres",
      "--command",
      "SELECT rolcreatedb::text FROM pg_roles WHERE rolname = current_user",
    ]);
    return capability.stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function adminCommand(binary, args) {
  return execFileAsync(binary, [...postgresArgs, "--no-password", ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    env: localEnvironment(),
  });
}

async function cli(script, args) {
  return execFileAsync(process.execPath, [script.pathname, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    env: localEnvironment(),
  });
}

function syntheticRecord(overrides = {}) {
  return {
    entityType: "story",
    entityKey: "TAB-19",
    source: "plane",
    sourceId: "TAB-19",
    observedAt: "2026-09-02T12:00:00.000Z",
    checkpointId: "0123456789ab",
    sensitivity: "private",
    payload: { note: "safe synthetic metadata" },
    ...overrides,
  };
}

function localEnvironment() {
  const environment = { ...process.env, LC_ALL: "C", NO_COLOR: "1" };
  for (const key of ["PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGDATABASE", "PGPASSWORD", "PGPASSFILE", "PGPORT", "PGOPTIONS"]) {
    delete environment[key];
  }
  return environment;
}
