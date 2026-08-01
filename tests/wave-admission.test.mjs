import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

import {
  admitWave,
  REASON_CODES,
  validateWaveManifest
} from "../scripts/lib/wave-admission.mjs";
import {validateJsonSchema} from "../scripts/lib/json-schema-validator.mjs";

const execFileAsync = promisify(execFile);

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../examples/tabellio-wave/${name}`, import.meta.url)));
}

test("schema accepts bounded three-repository manifest", async () => {
  const manifest = await fixture("accepted-three-repository.json");
  const schema = JSON.parse(await readFile(
    new URL("../schemas/wave-manifest.v0.1.schema.json", import.meta.url)
  ));
  assert.deepEqual(validateJsonSchema(manifest, schema), []);
  assert.equal(validateWaveManifest(manifest), manifest);
});

test("workflow accepts independent Ready lanes with explicit WIP and integration ownership", async () => {
  const report = admitWave(await fixture("accepted-three-repository.json"));
  assert.equal(report.decision, "accepted");
  assert.equal(report.summary, "3 lane(s) accepted; 0 lane(s) rejected.");
  assert.deepEqual(report.lanes.map((lane) => lane.decision), ["accepted", "accepted", "accepted"]);
});

test("negative matrix rejects overlap and incomplete dependency with stable reasons", async () => {
  const report = admitWave(await fixture("rejected-overlap-dependency.json"));
  assert.equal(report.decision, "rejected");
  assert.deepEqual(
    report.lanes.find((lane) => lane.storyId === "INTB-283").reasons.map((item) => item.code),
    [REASON_CODES.DEPENDENCY_INCOMPLETE, REASON_CODES.SURFACE_OVERLAP]
  );
  assert.deepEqual(
    report.lanes.find((lane) => lane.storyId === "INTB-282").reasons.map((item) => item.code),
    [REASON_CODES.SURFACE_OVERLAP]
  );
});

test("negative matrix rejects non-Ready, WIP, missing mapping, stale base, and absent integrator", async () => {
  const manifest = await fixture("accepted-three-repository.json");
  manifest.wip.started = 1;
  manifest.finalIntegrator.mappingId = "missing";
  manifest.lanes[0].state = "In Progress";
  manifest.lanes[1].mappingId = "missing";
  manifest.lanes[2].observedBaseCommit = "4444444444444444444444444444444444444444";
  const report = admitWave(manifest);
  const codes = new Set(report.lanes.flatMap((lane) => lane.reasons.map((item) => item.code)));
  assert.deepEqual(
    [...codes].sort(),
    [
      REASON_CODES.INTEGRATOR_MISSING,
      REASON_CODES.LANE_NOT_READY,
      REASON_CODES.MAPPING_MISSING,
      REASON_CODES.STALE_BASE,
      REASON_CODES.WIP_LIMIT_EXCEEDED
    ].sort()
  );
});

test("repository identity is case-insensitive for overlap and base consistency", async () => {
  const overlapManifest = await fixture("accepted-three-repository.json");
  overlapManifest.mappings[1].repository = "intelip/tabellio";
  overlapManifest.lanes[1].ownedSurfaces = ["scripts/lib/**"];
  const overlapReport = admitWave(overlapManifest);
  assert.ok(overlapReport.lanes[0].reasons.some((item) => item.code === REASON_CODES.SURFACE_OVERLAP));
  assert.ok(overlapReport.lanes[1].reasons.some((item) => item.code === REASON_CODES.SURFACE_OVERLAP));

  const baseManifest = await fixture("accepted-three-repository.json");
  baseManifest.mappings[1].repository = "intelip/tabellio";
  const baseReport = admitWave(baseManifest);
  assert.ok(baseReport.lanes[0].reasons.some((item) => item.code === REASON_CODES.STALE_BASE));
  assert.ok(baseReport.lanes[1].reasons.some((item) => item.code === REASON_CODES.STALE_BASE));
});

test("mapping, glob, and in-wave dependency identity fail closed", async () => {
  const manifest = await fixture("accepted-three-repository.json");
  manifest.mappings[0].planeProject = "CTX";
  manifest.lanes[0].ownedSurfaces = ["scripts/*.mjs"];
  manifest.lanes[0].dependencies = [{
    storyId: manifest.lanes[1].storyId,
    status: "completed"
  }];
  const report = admitWave(manifest);
  const codes = report.lanes[0].reasons.map((item) => item.code);
  assert.ok(codes.includes(REASON_CODES.MAPPING_MISSING));
  assert.ok(codes.includes(REASON_CODES.SURFACE_INVALID));
  assert.ok(codes.includes(REASON_CODES.DEPENDENCY_INCOMPLETE));
});

test("schema and runtime both require UTC Z timestamps", async () => {
  const manifest = await fixture("accepted-three-repository.json");
  const schema = JSON.parse(await readFile(
    new URL("../schemas/wave-manifest.v0.1.schema.json", import.meta.url)
  ));
  manifest.capturedAt = "2026-07-31T18:00:00+00:00";
  assert.notDeepEqual(validateJsonSchema(manifest, schema), []);
  assert.throws(() => validateWaveManifest(manifest), /UTC RFC 3339/);
});

test("schema and runtime reject normalized invalid capture dates", async () => {
  const manifest = await fixture("accepted-three-repository.json");
  const schema = JSON.parse(await readFile(
    new URL("../schemas/wave-manifest.v0.1.schema.json", import.meta.url)
  ));
  manifest.capturedAt = "2026-02-30T00:00:00Z";
  assert.notDeepEqual(validateJsonSchema(manifest, schema), []);
  assert.throws(() => validateWaveManifest(manifest), /UTC RFC 3339/);
});

test("schema and runtime reject multiline bounded strings", async () => {
  const manifest = await fixture("accepted-three-repository.json");
  const schema = JSON.parse(await readFile(
    new URL("../schemas/wave-manifest.v0.1.schema.json", import.meta.url)
  ));
  manifest.finalIntegrator.owner = "owner\nname";
  assert.notDeepEqual(validateJsonSchema(manifest, schema), []);
  assert.throws(() => validateWaveManifest(manifest), /single-line/);
});

test("security rejects unsafe owned surfaces and repository-external CLI inputs", async () => {
  const manifest = await fixture("accepted-three-repository.json");
  manifest.lanes[0].ownedSurfaces = ["../secrets"];
  const report = admitWave(manifest);
  assert.equal(report.lanes[0].reasons[0].code, REASON_CODES.SURFACE_INVALID);
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/tabellio-wave-admit.mjs", "--manifest", "../outside.json"]),
    (error) => error.code === 2 && error.stderr.includes("manifest must stay inside the repository")
  );

  const externalRoot = await mkdtemp(join(tmpdir(), "tabellio-wave-external-"));
  const linkRoot = await mkdtemp(join(process.cwd(), ".tabellio-wave-link-"));
  const externalManifest = join(externalRoot, "manifest.json");
  const manifestLink = join(linkRoot, "manifest.json");
  try {
    await writeFile(externalManifest, "{}\n");
    await symlink(externalManifest, manifestLink);
    await assert.rejects(
      execFileAsync(process.execPath, [
        "scripts/tabellio-wave-admit.mjs",
        "--manifest",
        manifestLink.slice(process.cwd().length + 1)
      ]),
      (error) => error.code === 2 && error.stderr.includes("manifest must stay inside the repository")
    );
  } finally {
    await rm(linkRoot, {recursive: true, force: true});
    await rm(externalRoot, {recursive: true, force: true});
  }
});

test("CLI renders business-readable accepted and rejected reports without external action", async () => {
  const accepted = await execFileAsync(process.execPath, [
    "scripts/tabellio-wave-admit.mjs",
    "--manifest",
    "examples/tabellio-wave/accepted-three-repository.json"
  ]);
  assert.equal(JSON.parse(accepted.stdout).decision, "accepted");
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/tabellio-wave-admit.mjs",
      "--manifest",
      "examples/tabellio-wave/rejected-overlap-dependency.json"
    ]),
    (error) => {
      const report = JSON.parse(error.stdout);
      return error.code === 1 &&
        report.lanes.some((lane) => lane.reasons.some((item) => item.code === REASON_CODES.SURFACE_OVERLAP)) &&
        report.lanes.some((lane) => lane.reasons.some((item) => item.code === REASON_CODES.DEPENDENCY_INCOMPLETE));
    }
  );
});
