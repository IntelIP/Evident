// Only these fixed messages may cross from source metadata into review packets.
export const SOURCE_FAILURES = Object.freeze({
  authentication: { state: "blocked", message: "Authenticate the source reader, then collect fresh evidence." },
  permission: { state: "blocked", message: "Restore read permission for the selected source record, then collect it again." },
  record_missing: { state: "missing", message: "Locate the selected record in its original source; do not infer a replacement." },
  source_unavailable: { state: "blocked", message: "Restore source availability, then collect fresh evidence." },
  reader_missing: { state: "missing", message: "Supply the required read-only source reader or original snapshot." },
  source_missing: { state: "missing", message: "Supply the original source snapshot." },
  selection_missing: { state: "missing", message: "Select explicit source identifiers for this candidate." },
  candidate_mismatch: { state: "conflicting", message: "Source evidence names another code candidate; reconcile base, head, and merge base." },
  scope_mismatch: { state: "conflicting", message: "Source evidence belongs to another project or repository; select matching evidence." },
  association_missing: { state: "missing", message: "Supply an explicit source association; titles and timestamps cannot establish the link." },
  malformed_response: { state: "blocked", message: "Collect a valid source snapshot; malformed evidence cannot establish readiness." },
  review_not_ready: { state: "blocked", message: "Use an open pull request that is ready for review." },
  review_binding_missing: { state: "missing", message: "Bind the review explicitly to this exact candidate before using it." },
  manifest_mismatch: { state: "conflicting", message: "Run validation with the selected manifest; the supplied receipt names another manifest." },
});
