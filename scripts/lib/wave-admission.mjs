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
  const waveReasons = [
    ...duplicateIdentityReasons(manifest),
    ...integratorReasons(manifest, mappingById)
  ];
  applyWipReasons(manifest, reasonsByLane);
  applyLaneReasons(manifest, mappingById, reasonsByLane);
  applyRepositoryBaseReasons(manifest, mappingById, reasonsByLane);
  applyOverlapReasons(manifest, mappingById, reasonsByLane);
  const lanes = manifest.lanes.map((lane) =>
    laneDecision(lane, waveReasons, reasonsByLane.get(lane.id))
  );
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

function duplicateIdentityReasons(manifest) {
  const identities = [
    ["Mapping id", manifest.mappings.map((mapping) => mapping.id)],
    ["Task id", manifest.mappings.map((mapping) => mapping.taskId)],
    ["Lane id", manifest.lanes.map((lane) => lane.id)],
    ["Story id", manifest.lanes.map((lane) => lane.storyId)]
  ];
  return identities.flatMap(([label, values]) =>
    duplicateValues(values).map((value) =>
      reason(REASON_CODES.DUPLICATE_IDENTITY, `${label} ${value} is duplicated.`)
    )
  );
}

function integratorReasons(manifest, mappingById) {
  const mappingExists = mappingById.has(manifest.finalIntegrator.mappingId);
  const ownerExists = manifest.finalIntegrator.owner.trim() !== "";
  return mappingExists && ownerExists
    ? []
    : [reason(
      REASON_CODES.INTEGRATOR_MISSING,
      "Final integration ownership does not resolve to a declared mapping."
    )];
}

function applyWipReasons(manifest, reasonsByLane) {
  const requestedSlots = manifest.lanes.reduce((sum, lane) => sum + lane.wipSlots, 0);
  if (manifest.wip.started + requestedSlots <= manifest.wip.limit) return;
  const message = `Wave requests ${requestedSlots} slot(s) with ${manifest.wip.started} already started; limit is ${manifest.wip.limit}.`;
  for (const lane of manifest.lanes) {
    reasonsByLane.get(lane.id).push(reason(REASON_CODES.WIP_LIMIT_EXCEEDED, message));
  }
}

function applyLaneReasons(manifest, mappingById, reasonsByLane) {
  const laneByStoryId = new Map(manifest.lanes.map((lane) => [lane.storyId, lane]));
  for (const lane of manifest.lanes) {
    reasonsByLane.get(lane.id).push(...laneReasons(lane, mappingById, laneByStoryId));
  }
}

function laneReasons(lane, mappingById, laneByStoryId) {
  return [
    ...mappingReasons(lane, mappingById),
    ...readinessReasons(lane),
    ...baseReasons(lane),
    ...dependencyReasons(lane, laneByStoryId),
    ...surfaceReasons(lane)
  ];
}

function mappingReasons(lane, mappingById) {
  const mapping = mappingById.get(lane.mappingId);
  const storyProject = lane.storyId.split("-", 1)[0];
  return mapping && mapping.planeProject === storyProject
    ? []
    : [reason(
      REASON_CODES.MAPPING_MISSING,
      `Lane ${lane.id} does not resolve to a declared Plane/repository/task mapping.`
    )];
}

function readinessReasons(lane) {
  return lane.state === "Ready"
    ? []
    : [reason(
      REASON_CODES.LANE_NOT_READY,
      `Story ${lane.storyId} is ${lane.state}; Ready is required.`
    )];
}

function baseReasons(lane) {
  return lane.baseCommit === lane.observedBaseCommit
    ? []
    : [reason(
      REASON_CODES.STALE_BASE,
      `Story ${lane.storyId} base commit differs from current repository evidence.`
    )];
}

function dependencyReasons(lane, laneByStoryId) {
  return lane.dependencies
    .filter((dependency) => {
      const dependencyLane = laneByStoryId.get(dependency.storyId);
      const dependencyIsInFlight = dependencyLane &&
        !["Completed", "Done"].includes(dependencyLane.state);
      return dependency.status !== "completed" || dependencyIsInFlight;
    })
    .map((dependency) => reason(
      REASON_CODES.DEPENDENCY_INCOMPLETE,
      `Story ${lane.storyId} dependency ${dependency.storyId} is incomplete.`
    ));
}

function surfaceReasons(lane) {
  return lane.ownedSurfaces
    .filter((surface) => !safeSurface(surface))
    .map(() => reason(
      REASON_CODES.SURFACE_INVALID,
      `Story ${lane.storyId} owned surface is not a safe repository-relative pattern.`
    ));
}

function applyRepositoryBaseReasons(manifest, mappingById, reasonsByLane) {
  const lanesByRepository = groupLanesByRepository(manifest.lanes, mappingById);
  for (const [repository, lanes] of lanesByRepository) {
    if (new Set(lanes.map((lane) => lane.observedBaseCommit)).size <= 1) continue;
    const message = `Repository ${repository} has conflicting current base evidence in this wave.`;
    for (const lane of lanes) {
      reasonsByLane.get(lane.id).push(reason(REASON_CODES.STALE_BASE, message));
    }
  }
}

function groupLanesByRepository(lanes, mappingById) {
  const lanesByRepository = new Map();
  for (const lane of lanes) {
    const mapping = mappingById.get(lane.mappingId);
    if (!mapping) continue;
    const repository = canonicalRepository(mapping.repository);
    const repositoryLanes = lanesByRepository.get(repository) ?? [];
    repositoryLanes.push(lane);
    lanesByRepository.set(repository, repositoryLanes);
  }
  return lanesByRepository;
}

function applyOverlapReasons(manifest, mappingById, reasonsByLane) {
  for (const [left, right] of lanePairs(manifest.lanes)) {
    const overlap = laneOverlap(left, right, mappingById);
    if (!overlap) continue;
    const message = `Stories ${left.storyId} and ${right.storyId} overlap in ${overlap.repository}: ${overlap.surfaces[0]} <> ${overlap.surfaces[1]}.`;
    reasonsByLane.get(left.id).push(reason(REASON_CODES.SURFACE_OVERLAP, message));
    reasonsByLane.get(right.id).push(reason(REASON_CODES.SURFACE_OVERLAP, message));
  }
}

function lanePairs(lanes) {
  const pairs = [];
  for (let left = 0; left < lanes.length; left += 1) {
    for (let right = left + 1; right < lanes.length; right += 1) {
      pairs.push([lanes[left], lanes[right]]);
    }
  }
  return pairs;
}

function laneOverlap(left, right, mappingById) {
  const leftMapping = mappingById.get(left.mappingId);
  const rightMapping = mappingById.get(right.mappingId);
  const repository = sharedRepository(leftMapping, rightMapping);
  if (!repository) return null;
  const surfaces = firstOverlap(left.ownedSurfaces, right.ownedSurfaces);
  return surfaces ? {repository, surfaces} : null;
}

function sharedRepository(leftMapping, rightMapping) {
  if (!leftMapping) return null;
  if (!rightMapping) return null;
  const leftRepository = canonicalRepository(leftMapping.repository);
  const rightRepository = canonicalRepository(rightMapping.repository);
  return leftRepository === rightRepository ? leftRepository : null;
}

function canonicalRepository(value) {
  return value.toLowerCase();
}

function laneDecision(lane, waveReasons, laneSpecificReasons) {
  const reasons = stableReasons([...waveReasons, ...laneSpecificReasons]);
  return {
    id: lane.id,
    storyId: lane.storyId,
    decision: reasons.length === 0 ? "accepted" : "rejected",
    reasons
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
  if (typeof value !== "string") return false;
  const invalidShape = [
    value === "",
    value.includes("\\"),
    value.startsWith("/"),
    value.endsWith("/"),
    /[\0\r\n]/.test(value)
  ];
  if (invalidShape.includes(true)) return false;
  const plain = stripSurfaceGlob(value);
  const invalidPlain = [
    plain === "",
    plain.startsWith("./"),
    plain.includes("//"),
    /[*?[\]{}]/.test(plain)
  ];
  if (invalidPlain.includes(true)) return false;
  return plain.split("/").every((part) => !["", ".", ".."].includes(part));
}

function stripSurfaceGlob(value) {
  return value.endsWith("/**") ? value.slice(0, -3) : value;
}

function firstOverlap(leftSurfaces, rightSurfaces) {
  return surfacePairs(leftSurfaces, rightSurfaces).find(([left, right]) =>
    safeSurface(left) && safeSurface(right) && surfacesOverlap(left, right)
  ) ?? null;
}

function surfacePairs(leftSurfaces, rightSurfaces) {
  return leftSurfaces.flatMap((left) =>
    rightSurfaces.map((right) => [left, right])
  );
}

function surfacesOverlap(left, right) {
  const leftSurface = normalizedSurface(left);
  const rightSurface = normalizedSurface(right);
  return leftSurface.path === rightSurface.path ||
    parentSurfaceContains(leftSurface, rightSurface.path) ||
    parentSurfaceContains(rightSurface, leftSurface.path);
}

function parentSurfaceContains(surface, path) {
  return surface.prefix && path.startsWith(`${surface.path}/`);
}

function normalizedSurface(value) {
  const prefix = value.endsWith("/**");
  return {path: stripSurfaceGlob(value), prefix};
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
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !actual.includes(key));
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (missing.length + unexpected.length === 0) return;
  throw new Error(`${path} must contain exactly: ${[...expected].sort().join(", ")}.`);
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
  const invalid = [typeof value !== "string", value === "", value.length > maximum, /[\0\r\n]/.test(value)];
  if (!invalid.includes(true)) return;
  throw new Error(`${path} must be a non-empty single-line string up to ${maximum} characters.`);
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
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  const parsed = new Date(value);
  const exact = parts &&
    parsed.getUTCFullYear() === Number(parts[1]) &&
    parsed.getUTCMonth() + 1 === Number(parts[2]) &&
    parsed.getUTCDate() === Number(parts[3]) &&
    parsed.getUTCHours() === Number(parts[4]) &&
    parsed.getUTCMinutes() === Number(parts[5]) &&
    parsed.getUTCSeconds() === Number(parts[6]);
  if (!Number.isFinite(parsed.getTime()) || !exact) {
    throw new Error(`${path} must be a UTC RFC 3339 timestamp.`);
  }
}
