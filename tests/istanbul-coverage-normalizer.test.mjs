import assert from "node:assert/strict";
import test from "node:test";

import { normalizeIstanbulCoverage } from "../.buildkite/scripts/normalize-istanbul-coverage.mjs";

function fixture() {
  return {
    "/repo/example.mjs": {
      statementMap: {
        0: { start: { line: 1, column: -1 }, end: { line: 1, column: 9 } }
      },
      fnMap: {
        0: {
          decl: { start: { line: 2, column: -1 }, end: { line: 2, column: 8 } },
          loc: { start: { line: 2, column: -1 }, end: { line: 3, column: 1 } }
        }
      },
      branchMap: {
        0: {
          loc: { start: { line: 4, column: -1 }, end: { line: 4, column: 12 } },
          locations: [{ start: { line: 4, column: -1 }, end: { line: 4, column: 5 } }]
        }
      },
      s: { 0: 7 },
      f: { 0: 3 },
      b: { 0: [2] }
    }
  };
}

test("normalizes only Istanbul's unsupported negative location columns", () => {
  const coverage = fixture();
  const countersBefore = structuredClone({ s: coverage["/repo/example.mjs"].s, f: coverage["/repo/example.mjs"].f, b: coverage["/repo/example.mjs"].b });

  assert.equal(normalizeIstanbulCoverage(coverage), 5);
  assert.deepEqual(coverage["/repo/example.mjs"].s, countersBefore.s);
  assert.deepEqual(coverage["/repo/example.mjs"].f, countersBefore.f);
  assert.deepEqual(coverage["/repo/example.mjs"].b, countersBefore.b);
  assert.equal(coverage["/repo/example.mjs"].statementMap[0].start.column, 0);
  assert.equal(coverage["/repo/example.mjs"].fnMap[0].decl.start.column, 0);
  assert.equal(coverage["/repo/example.mjs"].fnMap[0].loc.start.column, 0);
  assert.equal(coverage["/repo/example.mjs"].branchMap[0].loc.start.column, 0);
  assert.equal(coverage["/repo/example.mjs"].branchMap[0].locations[0].start.column, 0);
});

test("rejects malformed location data instead of silently changing it", () => {
  const coverage = fixture();
  coverage["/repo/example.mjs"].branchMap[0].loc.start.column = -2;

  assert.throws(() => normalizeIstanbulCoverage(coverage), /greater than or equal to -1/);
});
