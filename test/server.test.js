const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createServer } = require("../server");

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

function githubFetch() {
  return async () =>
    jsonResponse([
      { homepage: "https://example.com" },
      { homepage: "https://github.com/octocat" },
      { homepage: "http://127.0.0.1:3000" },
      { homepage: "https://shop.example/path" },
    ]);
}

async function withServer(t, options) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  return server.address().port;
}

function request(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: requestPath,
        agent: false,
        headers: payload
          ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("serves the frontend", async (t) => {
  const port = await withServer(t, { fetchImpl: githubFetch(), captureSites: async () => [] });
  const page = await request(port, "GET", "/");
  assert.equal(page.status, 200);
  assert.match(page.raw.toString("utf8"), /Repo Screenshot/);
  assert.match(page.headers["content-type"], /text\/html/);
});

test("lists public homepages and only captures those urls", async (t) => {
  let captured = [];
  const port = await withServer(t, {
    fetchImpl: githubFetch(),
    async captureSites(urls, options) {
      captured = urls.slice();
      const results = [];
      for (const url of urls) {
        const host = new URL(url).hostname;
        const dir = path.join(options.outputDir, host);
        fs.mkdirSync(dir, { recursive: true });
        const desktop = path.join(dir, `${host}_desktop.jpeg`);
        const mobile = path.join(dir, `${host}_mobile.jpeg`);
        fs.writeFileSync(desktop, Buffer.from("desktop-jpeg"));
        fs.writeFileSync(mobile, Buffer.from("mobile-jpeg"));
        const result = { url, files: { desktop, mobile }, errors: {} };
        results.push(result);
        if (options.onProgress) await options.onProgress(result);
      }
      return results;
    },
  });

  const listed = await request(port, "POST", "/api/homepages", { username: "octocat" });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.homepages, ["https://example.com/", "https://shop.example/path"]);
  assert.equal(listed.json.blocked, 1);

  const foreign = await request(port, "POST", "/api/jobs", {
    username: "octocat",
    urls: ["https://evil.example/"],
  });
  assert.equal(foreign.status, 400);
  assert.equal(captured.length, 0);

  const created = await request(port, "POST", "/api/jobs", {
    username: "octocat",
    urls: [listed.json.homepages[0]],
  });
  assert.equal(created.status, 202);

  let job = created.json;
  for (let attempt = 0; attempt < 20 && job.status !== "done"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = (await request(port, "GET", `/api/jobs/${created.json.id}`)).json;
  }

  assert.equal(job.status, "done");
  assert.deepEqual(captured, ["https://example.com/"]);
  const image = await request(port, "GET", job.results[0].desktop);
  assert.equal(image.status, 200);
  assert.equal(image.headers["content-type"], "image/jpeg");
  assert.equal(image.raw.toString("utf8"), "desktop-jpeg");

  const missing = await request(port, "GET", "/api/jobs/0123456789abcdef");
  assert.equal(missing.status, 404);
});

test("rejects an invalid username before calling GitHub", async (t) => {
  let calls = 0;
  const port = await withServer(t, {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse([]);
    },
    captureSites: async () => [],
  });
  const response = await request(port, "POST", "/api/homepages", { username: "../admin" });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});
