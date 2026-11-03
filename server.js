const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { fetchUserRepos, homepagesFromRepos } = require("./lib/repos");
const { captureSites } = require("./lib/capture");
const { partitionHomepages, selectCaptureUrls } = require("./lib/policy");
const siteAssets = require("./lib/site-assets");

const PUBLIC_DIR = path.join(__dirname, "public");
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
};
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertUsername(username) {
  const name = typeof username === "string" ? username.trim() : "";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(name)) {
    throw httpError("Usuário do GitHub inválido.", 400);
  }
  return name;
}

function translateGithubError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/was not found/i.test(message)) return httpError("Usuário não encontrado no GitHub.", 404);
  if (/rate limit/i.test(message)) {
    return httpError("Limite de requisições do GitHub. Informe um token e tente de novo.", 429);
  }
  if (/rejected the token/i.test(message)) return httpError("O GitHub recusou o token.", 401);
  return httpError(message, error.statusCode || 502);
}

function readBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === "string" && req.body.length) {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch {
      return Promise.reject(httpError("JSON inválido.", 400));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(httpError("Corpo da requisição grande demais.", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError("JSON inválido.", 400));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    username: job.username,
    total: job.total,
    completed: job.completed,
    results: job.results,
    error: job.error,
  };
}

function createServer(options = {}) {
  const fetchImpl = options.fetchImpl;
  const shoot = options.captureSites || captureSites;
  const jobs = new Map();
  const queue = [];
  let active = false;

  function remember(job) {
    jobs.set(job.id, job);
    while (jobs.size > 20) {
      const oldestId = jobs.keys().next().value;
      if (oldestId === job.id) break;
      const oldest = jobs.get(oldestId);
      jobs.delete(oldestId);
      if (oldest && oldest.status !== "running" && oldest.status !== "queued") {
        fs.rmSync(oldest.dir, { recursive: true, force: true });
      }
    }
  }

  function onVercel() {
    return Boolean(process.env.VERCEL);
  }

  function captureLimit() {
    return onVercel() ? 2 : 6;
  }

  async function runJob(job) {
    job.status = "running";
    const inlineImages = onVercel();
    try {
      await shoot(job.urls, {
        outputDir: job.dir,
        delayMs: inlineImages ? 0 : 500,
        quality: inlineImages ? 60 : 80,
        timeoutMs: inlineImages ? 20_000 : 30_000,
        hide: ["#modal"],
        fullPage: false,
        async onProgress(result) {
          job.results.push(toPublicResult(job, result, inlineImages));
          job.completed = job.results.length;
        },
      });
      job.status = "done";
    } catch (error) {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
    }
  }

  async function drain() {
    if (active) return;
    const job = queue.shift();
    if (!job) return;
    active = true;
    try {
      await runJob(job);
    } finally {
      active = false;
      drain().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
      });
    }
  }

  function enqueue(job) {
    queue.push(job);
    drain();
  }

  async function loadHomepages(username, token) {
    let repos;
    let truncated;
    try {
      ({ repos, truncated } = await fetchUserRepos(username, {
        token,
        fetchImpl,
      }));
    } catch (error) {
      throw translateGithubError(error);
    }
    const homepages = homepagesFromRepos(repos, username);
    const parts = partitionHomepages(homepages);
    return { truncated: Boolean(truncated), ...parts };
  }

  async function handle(req, res) {
    try {
      await route(req, res);
    } catch (error) {
      if (res.headersSent) return;
      const status = error.statusCode || 500;
      const message = status === 500 ? "Falha interna do servidor." : error.message;
      sendJson(res, status, { error: message });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
    });
  });
  server.handle = handle;

  async function route(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && STATIC_FILES[url.pathname]) {
      serveStatic(res, STATIC_FILES[url.pathname]);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/homepages") {
      const body = await readBody(req);
      const username = assertUsername(body.username);
      const token = readToken(body.token);
      const { visible, blocked, truncated } = await loadHomepages(username, token);
      sendJson(res, 200, {
        username,
        truncated,
        blocked: blocked.length,
        maxCaptures: captureLimit(),
        homepages: visible,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const body = await readBody(req);
      const username = assertUsername(body.username);
      const token = readToken(body.token);
      const { visible } = await loadHomepages(username, token);
      let urls;
      try {
        urls = selectCaptureUrls(visible, body.urls, captureLimit());
      } catch (error) {
        throw httpError(error.message, 400);
      }

      const id = crypto.randomBytes(8).toString("hex");
      const dir = path.join(os.tmpdir(), "repo-screenshot", id);
      fs.mkdirSync(dir, { recursive: true });
      const job = {
        id,
        dir,
        username,
        urls,
        status: "queued",
        total: urls.length,
        completed: 0,
        results: [],
        error: null,
        files: new Map(),
      };
      remember(job);
      if (onVercel()) {
        await runJob(job);
        sendJson(res, 200, publicJob(job));
        return;
      }
      enqueue(job);
      sendJson(res, 202, publicJob(job));
      return;
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9]{16})$/);
    if (req.method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) throw httpError("Captura não encontrada.", 404);
      sendJson(res, 200, publicJob(job));
      return;
    }

    const shotMatch = url.pathname.match(/^\/shots\/([a-f0-9]{16})\/([^/]+)$/);
    if (req.method === "GET" && shotMatch) {
      const job = jobs.get(shotMatch[1]);
      const name = decodeURIComponent(shotMatch[2]);
      const filePath = job && job.files.get(name);
      if (!filePath || !fs.existsSync(filePath)) throw httpError("Imagem não encontrada.", 404);
      const body = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }

    throw httpError("Não encontrado.", 404);
  }

  return server;
}

function readToken(token) {
  if (token === undefined || token === null || token === "") {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  }
  if (typeof token !== "string" || token.length > 300) {
    throw httpError("Token inválido.", 400);
  }
  return token.trim();
}

function toPublicResult(job, result, inlineImages) {
  const files = {};
  for (const [viewport, filePath] of Object.entries(result.files)) {
    const name = path.basename(filePath);
    job.files.set(name, filePath);
    files[viewport] = inlineImages
      ? `data:image/jpeg;base64,${fs.readFileSync(filePath).toString("base64")}`
      : `/shots/${job.id}/${encodeURIComponent(name)}`;
  }
  let host = result.url;
  try {
    host = new URL(result.url).hostname;
  } catch {
    host = result.url;
  }
  return {
    url: result.url,
    host,
    desktop: files.desktop || null,
    mobile: files.mobile || null,
    desktopError: result.errors.desktop || null,
    mobileError: result.errors.mobile || null,
  };
}

function serveStatic(res, filename) {
  const filePath = path.join(PUBLIC_DIR, filename);
  const body = fs.existsSync(filePath) ? fs.readFileSync(filePath) : siteAssets[filename];
  if (body === undefined) throw httpError("Não encontrado.", 404);
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(filename)] || "application/octet-stream",
    "Content-Length": payload.length,
    "Cache-Control": "no-cache",
  });
  res.end(payload);
}

const server = createServer();

function listen() {
  if (server.listening) return server;
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.VERCEL ? "0.0.0.0" : "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`Repo Screenshot em http://${host}:${port}`);
  });
  return server;
}

if (require.main === module) listen();

function handler(req, res) {
  return server.handle(req, res);
}

module.exports = handler;
module.exports.createServer = createServer;
