globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  let body;
  if (parsed.pathname === "/v2/organizations/intelip/pipelines/tabellio") {
    body = {
      repository: "https://github.com/IntelIP/Tabellio.git",
      slug: "tabellio",
    };
  } else if (
    parsed.pathname === "/v2/organizations/intelip/pipelines/tabellio/builds"
  ) {
    body = [];
  } else {
    throw new Error(`Unexpected Buildkite fixture URL: ${parsed.pathname}`);
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
