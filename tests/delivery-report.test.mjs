import assert from "node:assert/strict";
import test from "node:test";
import { joinDeliveryEvidence } from "../scripts/lib/delivery-evidence-joiner.mjs";
import { renderDeliveryReport } from "../scripts/lib/delivery-report.mjs";
import { buildkite, plane, provider, releases } from "./helpers/delivery-evidence-fixture.mjs";
test("delivery report preserves GitHub Release shipping boundary",()=>{const snapshot=joinDeliveryEvidence({providerSnapshot:provider(),planeSnapshot:plane(),buildkiteSnapshots:[buildkite()],releaseSnapshot:releases()});const report=renderDeliveryReport(snapshot);assert.match(report,/Shipped \(published GitHub Release\): 1\/1/);assert.match(report,/Deployment runtime proof is missing/);});
test("delivery report rejects a record ID that could inject Markdown",()=>{const snapshot=joinDeliveryEvidence({providerSnapshot:provider(),planeSnapshot:plane(),buildkiteSnapshots:[buildkite()],releaseSnapshot:releases()});snapshot.deliveryRecords[0].id="change-1\n\n## Decision";assert.throws(()=>renderDeliveryReport(snapshot),/portable single-line identifiers/);});
