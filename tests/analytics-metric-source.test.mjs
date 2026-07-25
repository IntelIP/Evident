import assert from "node:assert/strict";
import test from "node:test";

import { metricSourceAvailabilityMatches } from "../scripts/lib/analytics.mjs";

test("metric source availability requires measured values from available sources", () => {
  const source = { status: "available" };
  assert.equal(metricSourceAvailabilityMatches("commitCount", { status: "measured", unit: "count" }, [source]), true);
  assert.equal(metricSourceAvailabilityMatches("commitCount", { status: "blocked", unit: "count" }, [source]), false);
  assert.equal(metricSourceAvailabilityMatches("commitCount", { status: "blocked", unit: "count" }, [{ status: "blocked" }]), true);
});

test("availability and bare-worktree metrics use their special evidence rules", () => {
  assert.equal(metricSourceAvailabilityMatches("evidenceCompleteness", { status: "measured", numerator: 1, denominator: 2 }, [{ status: "available" }, { status: "blocked" }]), true);
  assert.equal(metricSourceAvailabilityMatches("evidenceCompleteness", { status: "measured", numerator: 2, denominator: 2 }, [{ status: "available" }, { status: "blocked" }]), false);
  assert.equal(metricSourceAvailabilityMatches("worktreeDirty", { status: "not_applicable", unit: "boolean", reason: "Bare repository has no worktree." }, [{ status: "available" }]), true);
});
