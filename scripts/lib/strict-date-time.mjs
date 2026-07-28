const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export function canonicalDateTime(value) {
  if (typeof value !== "string") return null;
  const match = DATE_TIME.exec(value);
  if (match === null) return null;
  if (!hasValidParts(match)) return null;
  const parsed = Date.parse(value);
  return canonicalParsedDate(parsed);
}

export function isStrictDateTime(value) {
  return canonicalDateTime(value) !== null;
}

function canonicalParsedDate(value) {
  if (!Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function hasValidParts(match) {
  const expected = match.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = expected;
  if (year <= 0) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const actual = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  return expected.every((part, index) => part === actual[index])
    && validOffset(match[8]);
}

function validOffset(zone) {
  if (zone === "Z") return true;
  const [hours, minutes] = zone.slice(1).split(":").map(Number);
  return hours <= 23 && minutes <= 59;
}
