import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  joinDeliveryEvidence,
} from "../scripts/lib/delivery-evidence-joiner.mjs";
import { renderDeliveryReport } from "../scripts/lib/delivery-report.mjs";
import {
  buildkite,
  deployment,
  plane,
  provider,
  releases,
} from "./helpers/delivery-evidence-fixture.mjs";

const execFileAsync = promisify(execFile);
const buildkiteAuthority = { organization: "intelip", pipeline: "tabellio" };

test("delivery report preserves GitHub Release shipping boundary", () => {
  const snapshot = joinedSnapshot();
  const report = renderDeliveryReport(snapshot);
  assert.match(report, /Shipped \(published GitHub Release\): 1\/1/);
  assert.match(report, /Deployment runtime proof is missing/);
});

test("delivery report validates its snapshot and cadence", () => {
  const snapshot = joinedSnapshot();
  assert.throws(
    () => renderDeliveryReport({ ...snapshot, schemaVersion: "wrong" }),
    /Invalid delivery evidence snapshot/,
  );
  assert.throws(
    () => renderDeliveryReport(snapshot, { cadence: "hourly" }),
    /daily, weekly, or monthly/,
  );
});

test("delivery report escapes record IDs and blocked source reasons", () => {
  const providerSnapshot = provider();
  providerSnapshot.deliveryChanges[0].id = "change_1";
  const snapshot = joinDeliveryEvidence({
    providerSnapshot,
    planeSnapshot: plane(),
    buildkiteAuthority,
    buildkiteSnapshots: [buildkite()],
    releaseSnapshot: releases(),
    deploymentBlockedReason: "<img_src=x>",
    deploymentEnvironment: "production",
  });
  const report = renderDeliveryReport(snapshot);
  assert.match(report, /change\\_1/);
  assert.match(report, /&lt;img\\_src=x&gt;/);
  assert.doesNotMatch(report, /<img_src=x>/);
});

test("delivery report treats unlinked and failed CI records as gaps", () => {
  const unlinkedProvider = provider();
  unlinkedProvider.deliveryChanges[0] = {
    ...unlinkedProvider.deliveryChanges[0],
    linkBasis: "unlinked",
    linkEvidence: null,
    planeStoryId: null,
    pullRequestNumber: null,
  };
  const unlinkedReport = renderDeliveryReport(joinedSnapshot({
    providerSnapshot: unlinkedProvider,
  }));
  assert.match(unlinkedReport, /lack an explicit Plane-to-PR relationship/);
  const failedBuildkite = buildkite();
  failedBuildkite.builds[0].state = "failed";
  const failedReport = renderDeliveryReport(joinedSnapshot({
    buildkiteSnapshot: failedBuildkite,
  }));
  assert.match(failedReport, /lack passed exact-head Buildkite evidence/);
});

test("delivery evidence CLI forwards deployment receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-delivery-cli-"));
  try {
    const paths = await writeInputs(root, { deployments: [deployment()] });
    const out = join(root, "nested", "delivery.json");
    await runEvidenceCli(paths, out);
    const snapshot = JSON.parse(await readFile(out, "utf8"));
    assert.equal(snapshot.deliveryRecords[0].deployment.status, "passed");
    assert.equal(
      snapshot.sources.deployment.observations[0].evidence.id,
      "deploy-1",
    );
    console.log(`delivery_report_record_count=${snapshot.deliveryRecords.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery evidence CLI keeps output distinct from every input", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-delivery-alias-"));
  try {
    const paths = await writeInputs(root, { deployments: [deployment()] });
    const providerHardLink = join(root, "provider-hard-link.json");
    const providerSymbolicLink = join(root, "provider-symbolic-link.json");
    await link(paths.provider, providerHardLink);
    await symlink(paths.provider, providerSymbolicLink);
    for (const out of [
      paths.provider,
      paths.plane,
      paths.buildkite,
      paths.releases,
      paths.deployments,
      providerHardLink,
      providerSymbolicLink,
    ]) {
      await assert.rejects(
        runEvidenceCli(paths, out),
        /must not (?:alias an input snapshot|be a symbolic link)/,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery report CLI refuses to overwrite its snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "tabellio-delivery-report-"));
  try {
    const snapshotPath = join(root, "snapshot.json");
    const snapshot = joinedSnapshot();
    const original = `${JSON.stringify(snapshot, null, 2)}\n`;
    await writeFile(snapshotPath, original);
    await assert.rejects(
      execFileAsync(process.execPath, [
        "scripts/tabellio-delivery-report.mjs",
        "render",
        "--snapshot", snapshotPath,
        "--cadence", "daily",
        "--out", snapshotPath,
      ], { cwd: process.cwd() }),
      /must not alias the input snapshot/,
    );
    assert.equal(await readFile(snapshotPath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function joinedSnapshot({
  providerSnapshot = provider(),
  buildkiteSnapshot = buildkite(),
} = {}) {
  return joinDeliveryEvidence({
    providerSnapshot,
    planeSnapshot: plane(),
    buildkiteAuthority,
    buildkiteSnapshots: [buildkiteSnapshot],
    releaseSnapshot: releases(),
  });
}

async function writeInputs(root, { deployments }) {
  const values = {
    provider: provider(),
    plane: plane(),
    buildkite: buildkite(),
    releases: releases(),
    deployments,
  };
  const paths = {};
  for (const [name, value] of Object.entries(values)) {
    paths[name] = join(root, `${name}.json`);
    await writeFile(paths[name], `${JSON.stringify(value, null, 2)}\n`);
  }
  return paths;
}

async function runEvidenceCli(paths, out) {
  return execFileAsync(process.execPath, [
    "scripts/tabellio-delivery-evidence.mjs",
    "join",
    "--provider", paths.provider,
    "--plane", paths.plane,
    "--buildkite", paths.buildkite,
    "--buildkite-organization", "intelip",
    "--buildkite-pipeline", "tabellio",
    "--releases", paths.releases,
    "--deployments", paths.deployments,
    "--deployment-environment", "production",
    "--out", out,
  ], { cwd: process.cwd() });
}
