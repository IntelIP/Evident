import assert from "node:assert/strict";
import test from "node:test";
import { joinDeliveryEvidence } from "../scripts/lib/delivery-evidence-joiner.mjs";
import { buildkite, fixture, plane, provider, releases } from "./helpers/delivery-evidence-fixture.mjs";
test("delivery join requires explicit Plane key and exact commit evidence",()=>{const x=joinDeliveryEvidence({providerSnapshot:provider(),planeSnapshot:plane(),buildkiteSnapshots:[buildkite()],releaseSnapshot:releases()});const r=x.deliveryRecords[0];assert.deepEqual(r.plane,{status:"linked",key:"INTB-260",stateGroup:"started",updatedAt:fixture.at});assert.equal(r.ci.status,"passed");assert.equal(r.release.status,"shipped");assert.equal(r.deployment.status,"unavailable");});
test("release shipping remains true without deployment proof",()=>{const x=joinDeliveryEvidence({providerSnapshot:provider(),planeSnapshot:plane(),buildkiteSnapshots:[buildkite()],releaseSnapshot:releases()});assert.equal(x.deliveryRecords[0].release.status,"shipped");assert.equal(x.deliveryRecords[0].deployment.status,"unavailable");});
