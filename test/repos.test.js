const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalHomepage,
  homepagesFromRepos,
  siteDirectoryName,
  fetchUserRepos,
} = require("../lib/repos");

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

test("adds https to homepages without a scheme", () => {
  assert.equal(canonicalHomepage("example.com/docs", "lucwx"), "https://example.com/docs");
});

test("drops the profile URL in any common form", () => {
  for (const homepage of [
    "https://github.com/lucwx",
    "https://github.com/Lucwx/",
    "http://www.github.com/lucwx",
    "https://github.com/lucwx?tab=repositories",
  ]) {
    assert.equal(canonicalHomepage(homepage, "lucwx"), null);
  }
});

test("keeps a GitHub repository page and rejects non-http schemes", () => {
  assert.equal(
    canonicalHomepage("https://github.com/lucwx/repo-screenshot", "lucwx"),
    "https://github.com/lucwx/repo-screenshot"
  );
  assert.equal(
    canonicalHomepage("https://github.com/other", "lucwx"),
    "https://github.com/other"
  );
  assert.equal(canonicalHomepage("javascript:alert(1)", "lucwx"), null);
  assert.equal(canonicalHomepage("   ", "lucwx"), null);
  assert.equal(canonicalHomepage(null, "lucwx"), null);
});

test("dedupes homepages and skips invalid ones", () => {
  const homepages = homepagesFromRepos(
    [
      { homepage: "https://Example.com/app/" },
      { homepage: "example.com/app" },
      { homepage: "" },
      { homepage: "not a url with spaces" },
      { homepage: "https://github.com/lucwx" },
      { homepage: "shop.example/path" },
      null,
      { name: "no-homepage" },
    ],
    "lucwx"
  );

  assert.deepEqual(homepages, [
    "https://example.com/app",
    "https://shop.example/path",
  ]);
});

test("rejects a non-array repository payload", () => {
  assert.throws(() => homepagesFromRepos({ message: "Not Found" }, "lucwx"), TypeError);
});

test("uses hostname and port in the output directory name", () => {
  assert.equal(siteDirectoryName("https://example.com/docs"), "example.com");
  assert.equal(siteDirectoryName("http://localhost:3000/"), "localhost_3000");
});

test("paginates until a short page and sends the token", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.Authorization });
    const page = Number(new URL(url).searchParams.get("page"));
    if (page === 1) {
      return jsonResponse([{ homepage: "https://one.example" }, { homepage: "https://two.example" }]);
    }
    return jsonResponse([{ homepage: "https://three.example" }]);
  };

  const result = await fetchUserRepos("lucwx", {
    fetchImpl,
    token: "secret",
    perPage: 2,
    maxPages: 5,
  });

  assert.equal(result.truncated, false);
  assert.equal(result.repos.length, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, "Bearer secret");
  assert.equal(new URL(calls[0].url).searchParams.get("per_page"), "2");
  assert.equal(new URL(calls[1].url).pathname, "/users/lucwx/repos");
});

test("does not send an authorization header without a token", async () => {
  let authorization = "unset";
  const fetchImpl = async (_url, init) => {
    authorization = init.headers.Authorization;
    return jsonResponse([]);
  };

  const result = await fetchUserRepos("octocat", { fetchImpl, perPage: 100 });
  assert.equal(authorization, undefined);
  assert.deepEqual(result, { repos: [], truncated: false });
});

test("reports truncation when every page is full", async () => {
  const fetchImpl = async () =>
    jsonResponse([{ homepage: "https://a.example" }, { homepage: "https://b.example" }]);

  const result = await fetchUserRepos("lucwx", { fetchImpl, perPage: 2, maxPages: 2 });
  assert.equal(result.repos.length, 4);
  assert.equal(result.truncated, true);
});

test("explains GitHub errors without treating them as repositories", async () => {
  const fetchImpl = async () => jsonResponse({ message: "Not Found" }, 404);
  await assert.rejects(
    () => fetchUserRepos("missing-user", { fetchImpl }),
    /GitHub user "missing-user" was not found/
  );

  const limited = async () => jsonResponse("rate limit", 403);
  await assert.rejects(() => fetchUserRepos("lucwx", { fetchImpl: limited }), /rate limit/);

  const weird = async () => jsonResponse({ message: "nope" }, 200);
  await assert.rejects(
    () => fetchUserRepos("lucwx", { fetchImpl: weird }),
    /did not return a list/
  );
});

test("requires a username before calling GitHub", async () => {
  await assert.rejects(() => fetchUserRepos("   ", {}), /username is required/);
});
