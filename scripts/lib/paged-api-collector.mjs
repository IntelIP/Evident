const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;

export async function collectPagedApi({ path, request, valuesFor, invalidPageMessage }) {
  const values = [];
  const pageFingerprints = new Set();
  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const page = await request(pagePath(path, pageNumber));
    const pageValues = valuesFor(page);
    if (!Array.isArray(pageValues)) throw new Error(invalidPageMessage);
    const fingerprint = JSON.stringify(pageValues);
    if (pageValues.length === 100 && pageFingerprints.has(fingerprint)) {
      throw new Error("Paged API response repeated a full page.");
    }
    pageFingerprints.add(fingerprint);
    values.push(...pageValues);
    if (values.length > MAX_ITEMS) throw new Error("Paged API item limit exceeded.");
    if (pageValues.length < 100) return values;
  }
  throw new Error("Paged API page limit exceeded.");
}

function pagePath(path, pageNumber) {
  if (pageNumber === 1) return path;
  return `${path}${path.includes("?") ? "&" : "?"}page=${pageNumber}`;
}
