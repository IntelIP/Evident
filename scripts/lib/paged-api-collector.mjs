const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;

export async function collectPagedApi({
  path,
  request,
  valuesFor = (page) => page,
  invalidPageMessage = "Paged API response is invalid.",
}) {
  const values = [];
  const fullPageFingerprints = new Set();

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const page = await request(withPage(path, pageNumber));
    const pageValues = valuesFor(page);
    if (!Array.isArray(pageValues)) throw new Error(invalidPageMessage);
    if (pageValues.length > PAGE_SIZE) throw new Error(invalidPageMessage);

    if (pageValues.length === PAGE_SIZE) {
      const fingerprint = JSON.stringify(pageValues);
      if (fullPageFingerprints.has(fingerprint)) {
        throw new Error("Paged API response repeated a full page.");
      }
      fullPageFingerprints.add(fingerprint);
    }

    values.push(...pageValues);
    if (values.length > MAX_ITEMS) throw new Error("Paged API item limit exceeded.");
    if (pageValues.length < PAGE_SIZE) return values;
  }

  throw new Error("Paged API page limit exceeded.");
}

function withPage(path, pageNumber) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}page=${pageNumber}`;
}
