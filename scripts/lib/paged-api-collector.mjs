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
    const complete = await collectPage({
      path,
      pageNumber,
      request,
      valuesFor,
      invalidPageMessage,
      values,
      fullPageFingerprints,
    });
    if (complete) return values;
  }

  throw new Error("Paged API page limit exceeded.");
}

async function collectPage(context) {
  const page = await context.request(withPage(context.path, context.pageNumber));
  const pageValues = context.valuesFor(page);
  assertPageValues(pageValues, context.invalidPageMessage);
  recordFullPage(pageValues, context.fullPageFingerprints);
  context.values.push(...pageValues);
  assertItemLimit(context.values);
  return pageValues.length < PAGE_SIZE;
}

function assertPageValues(values, message) {
  if (!Array.isArray(values)) throw new Error(message);
  if (values.length > PAGE_SIZE) throw new Error(message);
}

function recordFullPage(values, fingerprints) {
  if (values.length !== PAGE_SIZE) return;
  const fingerprint = JSON.stringify(values);
  if (fingerprints.has(fingerprint)) {
    throw new Error("Paged API response repeated a full page.");
  }
  fingerprints.add(fingerprint);
}

function assertItemLimit(values) {
  if (values.length > MAX_ITEMS) throw new Error("Paged API item limit exceeded.");
}

function withPage(path, pageNumber) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}page=${pageNumber}`;
}
