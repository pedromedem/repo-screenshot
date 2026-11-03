const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { createServer } = require("../server");

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
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
          let json = null;
          try {
            json = JSON.parse(raw.toString("utf8"));
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("on Vercel the capture finishes in the same response", async (t) => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  });

  const server = createServer({
    fetchImpl: async () =>
      jsonResponse([
        { homepage: "https://example.com" },
        { homepage: "https://shop.example" },
        { homepage: "https://third.example" },
      ]),
    async captureSites(urls, options) {
      const results = [];
      for (const url of urls) {
        const host = new URL(url).hostname;
        const dir = path.join(options.outputDir, host);
        fs.mkdirSync(dir, { recursive: true });
        const desktop = path.join(dir, `${host}_desktop.jpeg`);
        fs.writeFileSync(desktop, Buffer.from("jpeg"));
        const result = { url, files: { desktop }, errors: { mobile: "skip" } };
        results.push(result);
        if (options.onProgress) await options.onProgress(result);
      }
      return results;
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const { port } = server.address();

  const listed = await request(port, "POST", "/api/homepages", { username: "octocat" });
  assert.equal(listed.json.maxCaptures, 2);

  const tooMany = await request(port, "POST", "/api/jobs", {
    username: "octocat",
    urls: listed.json.homepages,
  });
  assert.equal(tooMany.status, 400);

  const created = await request(port, "POST", "/api/jobs", {
    username: "octocat",
    urls: [listed.json.homepages[0]],
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.status, "done");
  assert.match(created.json.results[0].desktop, /^data:image\/jpeg;base64,/);
  assert.equal(created.json.results[0].mobileError, "skip");
});
