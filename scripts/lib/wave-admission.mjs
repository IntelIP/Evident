const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STORY_PATTERN = /^[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*$/;
const PROJECT_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const REASON_CODES = Object.freeze({
  DEPENDENCY_INCOMPLETE: "DEPENDENCY_INCOMPLETE",
  DUPLICATE_IDENTITY: "DUPLICATE_IDENTITY",
  INTEGRATOR_MISSING: "INTEGRATOR_MISSING",
  LANE_NOT_READY: "LANE_NOT_READY",
  MAPPING_MISSING: "MAPPING_MISSING",
  STALE_BASE: "STALE_BASE",
  SURFACE_INVALID: "SURFACE_INVALID",
  SURFACE_OVERLAP: "SURFACE_OVERLAP",
  WIP_LIMIT_EXCEEDED: "WIP_LIMIT_EXCEEDED"
});

export function validateWaveManifest(value) {
  object(value, "manifest");
  exactKeys(
    value,
    ["schemaVersion", "id", "capturedAt", "wip", "finalIntegrator", "mappings", "lanes"],
    "manifest"
  );
  equal(value.schemaVersion, "tabellio-wave-manifest/v0.1", "manifest.schemaVersion");
  match(value.id, ID_PATTERN, "manifest.id");
  dateTime(value.capturedAt, "manifest.capturedAt");
  validateWip(value.wip);
  validateIntegrator(value.finalIntegrator);
  array(value.mappings, "manifest.mappings", 1, 100);
  value.mappings.forEach((mapping, index) => validateMapping(mapping, index));
  array(value.lanes, "manifest.lanes", 1, 100);
  value.lanes.forEach((lane, index) => validateLane(lane, index));
  return value;
}

export function admitWave(value) {
  const manifest = validateWaveManifest(value);
  const mappingById = new Map(manifest.mappings.map((mapping) => [mapping.id, mapping]));
  const reasonsByLane = new Map(manifest.lanes.map((lane) => [lane.id, []]));
  const waveReasons = [];

  duplicateValues(manifest.mappings.map((mapping) => mapping.id)).forEach((id) =>
    waveReasons.push(reason(REASON_CODES.DUPLICATE_IDENTITY, `Mapping id ${id} is duplicated.`))
  );
  duplicateValues(manifest.mappings.map((mapping) => mapping.taskId)).forEach((taskId) =>
    waveReasons.push(reason(REASON_CODES.DUPLICATE_IDENTITY, `Task id ${taskId} is duplicated.`))
  );
  duplicateValues(manifest.lanes.map((lane) => lane.id)).forEach((id) =>
    waveReasons.push(reason(REASON_CODES.DUPLICATE_IDENTITY, `Lane id ${id} is duplicated.`))
  );
  duplicateValues(manifest.lanes.map((lane) => lane.storyId)).forEach((storyId) =>
    waveReasons.push(reason(REASON_CODES.DUPLICATE_IDENTITY, `Story id ${storyId} is duplicated.`))
  );

  const integratorMapping = mappingById.get(manifest.finalIntegrator.mappingId);
  if (!integratorMapping || manifest.finalIntegrator.owner.trim() === "") {
    waveReasons.push(reason(
      REASON_CODES.INTEGRATOR_MISSING,
      "Final integration ownership does not resolve to a declared mapping."
    ));
  }

  const requestedSlots = manifest.lanes.reduce((sum, lane) => sum + lane.wipSlots, 0);
  if (manifest.wip.started + requestedSlots > manifest.wip.limit) {
    const message = `Wave requests ${requestedSlots} slot(s) with ${manifest.wip.started} already started; limit is ${manifest.wip.limit}.`;
    for (const lane of manifest.lanes) {
      reasonsByLane.get(lane.id).push(reason(REASON_CODES.WIP_LIMIT_EXCEEDED, message));
    }
  }

  for (const lane of manifest.lanes) {
    const laneReasons = reasonsByLane.get(lane.id);
    if (!mappingById.has(lane.mappingId)) {
      laneReasons.push(reason(
        REASON_CODES.MAPPING_MISSING,
        `Lane ${lane.id} does not resolve to a declared Plane/repository/task mapping.`
      ));
    }
    if (lane.state !== "Ready") {
      laneReasons.push(reason(
        REASON_CODES.LANE_NOT_READY,
        `Story ${lane.storyId} is ${lane.state}; Ready is required.`
      ));
    }
    if (lane.baseCommit !== lane.observedBaseCommit) {
      laneReasons.push(reason(
        REASON_CODES.STALE_BASE,
        `Story ${lane.storyId} base commit differs from current repository evidence.`
      ));
    }
    for (const dependency of lane.dependencies) {
      if (dependency.status !== "completed") {
        laneReasons.push(reason(
          REASON_CODES.DEPENDENCY_INCOMPLETE,
          `Story ${lane.storyId} dependency ${dependency.storyId} is incomplete.`
        ));
      }
    }
    for (const surface of lane.ownedSurfaces) {
      if (!safeSurface(surface)) {
        laneReasons.push(reason(
          REASON_CODES.SURFACE_INVALID,
          `Story ${lane.storyId} owned surface is not a safe repository-relative pattern.`
        ));
      }
    }
  }

  for (let leftIndex = 0; leftIndex < manifest.lanes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < manifest.lanes.length; rightIndex += 1) {
      const left = manifest.lanes[leftIndex];
      const right = manifest.lanes[rightIndex];
      const leftMapping = mappingById.get(left.mappingId);
      const rightMapping = mappingById.get(right.mappingId);
      if (!leftMapping || !rightMapping || leftMapping.repository !== rightMapping.repository) continue;
      const overlap = firstOverlap(left.ownedSurfaces, right.ownedSurfaces);
      if (!overlap) continue;
      const message = `Stories ${left.storyId} and ${right.storyId} overlap in ${leftMapping.repository}: ${overlap[0]} <> ${overlap[1]}.`;
      reasonsByLane.get(left.id).push(reason(REASON_CODES.SURFACE_OVERLAP, message));
      reasonsByLane.get(right.id).push(reason(REASON_CODES.SURFACE_OVERLAP, message));
    }
  }

  const lanes = manifest.lanes.map((lane) => {
    const reasons = stableReasons([...waveReasons, ...reasonsByLane.get(lane.id)]);
    return {
      id: lane.id,
      storyId: lane.storyId,
      decision: reasons.length === 0 ? "accepted" : "rejected",
      reasons
    };
  });
  const accepted = lanes.filter((lane) => lane.decision === "accepted").length;
  const rejected = lanes.length - accepted;
  return {
    schemaVersion: "tabellio-wave-admission/v0.1",
    waveId: manifest.id,
    decision: rejected === 0 ? "accepted" : "rejected",
    summary: `${accepted} lane(s) accepted; ${rejected} lane(s) rejected.`,
    lanes
  };
}

function validateWip(value) {
  object(value, "manifest.wip");
  exactKeys(value, ["limit", "started"], "manifest.wip");
  integer(value.limit, "manifest.wip.limit", 1, 3);
  integer(value.started, "manifest.wip.started", 0, 3);
}

function validateIntegrator(value) {
  object(value, "manifest.finalIntegrator");
  exactKeys(value, ["mappingId", "owner"], "manifest.finalIntegrator");
  string(value.mappingId, "manifest.finalIntegrator.mappingId", 128);
  string(value.owner, "manifest.finalIntegrator.owner", 200);
}

function validateMapping(value, index) {
  const path = `manifest.mappings[${index}]`;
  object(value, path);
  exactKeys(value, ["id", "planeProject", "repository", "taskId"], path);
  string(value.id, `${path}.id`, 128);
  match(value.planeProject, PROJECT_PATTERN, `${path}.planeProject`);
  match(value.repository, REPOSITORY_PATTERN, `${path}.repository`);
  string(value.taskId, `${path}.taskId`, 200);
}

function validateLane(value, index) {
  const path = `manifest.lanes[${index}]`;
  object(value, path);
  exactKeys(
    value,
    ["id", "mappingId", "storyId", "state", "baseCommit", "observedBaseCommit", "ownedSurfaces", "dependencies", "wipSlots"],
    path
  );
  string(value.id, `${path}.id`, 128);
  string(value.mappingId, `${path}.mappingId`, 128);
  match(value.storyId, STORY_PATTERN, `${path}.storyId`);
  string(value.state, `${path}.state`, 64);
  match(value.baseCommit, SHA_PATTERN, `${path}.baseCommit`);
  match(value.observedBaseCommit, SHA_PATTERN, `${path}.observedBaseCommit`);
  array(value.ownedSurfaces, `${path}.ownedSurfaces`, 1, 100);
  value.ownedSurfaces.forEach((surface, surfaceIndex) =>
    string(surface, `${path}.ownedSurfaces[${surfaceIndex}]`, 500)
  );
  array(value.dependencies, `${path}.dependencies`, 0, 100);
  value.dependencies.forEach((dependency, dependencyIndex) => {
    const dependencyPath = `${path}.dependencies[${dependencyIndex}]`;
    object(dependency, dependencyPath);
    exactKeys(dependency, ["storyId", "status"], dependencyPath);
    match(dependency.storyId, STORY_PATTERN, `${dependencyPath}.storyId`);
    if (!["completed", "incomplete"].includes(dependency.status)) {
      throw new Error(`${dependencyPath}.status must be completed or incomplete.`);
    }
  });
  integer(value.wipSlots, `${path}.wipSlots`, 1, 3);
}

function safeSurface(value) {
  if (typeof value !== "string" || value === "" || value.includes("\\")) return false;
  if (value.startsWith("/") || value.endsWith("/") || /[\0\r\n]/.test(value)) return false;
  const plain = value.endsWith("/**") ? value.slice(0, -3) : value;
  if (plain === "" || plain.startsWith("./") || plain.includes("//")) return false;
  return plain.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function firstOverlap(leftSurfaces, rightSurfaces) {
  for (const left of leftSurfaces) {
    if (!safeSurface(left)) continue;
    for (const right of rightSurfaces) {
      if (!safeSurface(right)) continue;
      if (surfacesOverlap(left, right)) return [left, right];
    }
  }
  return null;
}

function surfacesOverlap(left, right) {
  const leftPrefix = left.endsWith("/**");
  const rightPrefix = right.endsWith("/**");
  const leftPath = leftPrefix ? left.slice(0, -3) : left;
  const rightPath = rightPrefix ? right.slice(0, -3) : right;
  if (leftPath === rightPath) return true;
  if (leftPrefix && rightPath.startsWith(`${leftPath}/`)) return true;
  if (rightPrefix && leftPath.startsWith(`${rightPath}/`)) return true;
  return false;
}

function stableReasons(values) {
  return [...new Map(
    values
      .sort((left, right) => `${left.code}\0${left.message}`.localeCompare(`${right.code}\0${right.message}`))
      .map((value) => [`${value.code}\0${value.message}`, value])
  ).values()];
}

function reason(code, message) {
  return {code, message};
}

function duplicateValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([value]) => value).sort();
}

function exactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${path} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function object(value, path) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
}

function array(value, path, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error(`${path} must contain ${minimum} to ${maximum} items.`);
  }
}

function string(value, path, maximum) {
  if (typeof value !== "string" || value === "" || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`${path} must be a non-empty single-line string up to ${maximum} characters.`);
  }
}

function match(value, pattern, path) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${path} is invalid.`);
}

function equal(value, expected, path) {
  if (value !== expected) throw new Error(`${path} must be ${expected}.`);
}

function integer(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${path} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function dateTime(value, path) {
  string(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${path} must be a UTC RFC 3339 timestamp.`);
  }
}
