export async function collectPagedApi({ path, request, valuesFor, invalidPageMessage }) {
  const values = [];
  for (let pageNumber = 1; ; pageNumber += 1) {
    const page = await request(pagePath(path, pageNumber));
    const pageValues = valuesFor(page);
    if (!Array.isArray(pageValues)) throw new Error(invalidPageMessage);
    values.push(...pageValues);
    if (pageValues.length < 100) return values;
  }
}

function pagePath(path, pageNumber) {
  if (pageNumber === 1) return path;
  return `${path}${path.includes("?") ? "&" : "?"}page=${pageNumber}`;
}
