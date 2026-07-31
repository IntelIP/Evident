import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
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

test("security rejects unsafe owned surfaces and repository-external CLI inputs", async () => {
  const manifest = await fixture("accepted-three-repository.json");
  manifest.lanes[0].ownedSurfaces = ["../secrets"];
  const report = admitWave(manifest);
  assert.equal(report.lanes[0].reasons[0].code, REASON_CODES.SURFACE_INVALID);
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/tabellio-wave-admit.mjs", "--manifest", "../outside.json"]),
    (error) => error.code === 2 && error.stderr.includes("manifest must stay inside the repository")
  );
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
