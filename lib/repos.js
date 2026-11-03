const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 10;

function canonicalHomepage(raw, username) {
  if (typeof raw !== "string") return null;

  let value = raw.trim();
  if (!value) return null;

  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    value = `https://${value}`;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const port = url.port ? `:${url.port}` : "";
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const owner = String(username || "").trim().toLowerCase();
  const profileHosts = host === "github.com" || host === "www.github.com";
  if (owner && profileHosts && pathname.toLowerCase() === `/${owner}`) {
    return null;
  }

  return `${url.protocol}//${host}${port}${pathname}${url.search}`;
}

function homepagesFromRepos(repos, username) {
  if (!Array.isArray(repos)) {
    throw new TypeError("repos must be an array");
  }

  const seen = new Set();
  const homepages = [];

  for (const repo of repos) {
    const homepage = repo && typeof repo === "object" ? repo.homepage : undefined;
    const canonical = canonicalHomepage(homepage, username);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    homepages.push(canonical);
  }

  return homepages;
}

function siteDirectoryName(rawUrl) {
  const url = new URL(rawUrl);
  return url.port ? `${url.hostname}_${url.port}` : url.hostname;
}

async function fetchUserRepos(username, options = {}) {
  const name = typeof username === "string" ? username.trim() : "";
  if (!name) {
    throw new Error("GitHub username is required");
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available (Node.js 18 or newer is required)");
  }

  const perPage = options.perPage ?? DEFAULT_PER_PAGE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const token = options.token || "";
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "repo-screenshot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const repos = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(
      `https://api.github.com/users/${encodeURIComponent(name)}/repos`
    );
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));

    const response = await fetchImpl(url, { headers });
    if (!response.ok) {
      throw new Error(await githubError(response, name));
    }

    const batch = await response.json();
    if (!Array.isArray(batch)) {
      throw new Error("GitHub API did not return a list of repositories");
    }

    repos.push(...batch);
    if (batch.length < perPage) {
      return { repos, truncated: false };
    }
  }

  return { repos, truncated: true };
}

async function githubError(response, username) {
  if (response.status === 404) {
    return `GitHub user "${username}" was not found.`;
  }
  if (response.status === 401) {
    return "GitHub rejected the token. Check GITHUB_TOKEN and run again.";
  }
  if (response.status === 403 || response.status === 429) {
    return `GitHub API rate limit reached (${response.status}). Set GITHUB_TOKEN and run again.`;
  }

  let detail = "";
  try {
    detail = await response.text();
  } catch {
    detail = "";
  }
  const compact = String(detail).replace(/\s+/g, " ").trim().slice(0, 180);
  return compact
    ? `GitHub API ${response.status} for "${username}": ${compact}`
    : `GitHub API ${response.status} for "${username}".`;
}

module.exports = {
  canonicalHomepage,
  homepagesFromRepos,
  siteDirectoryName,
  fetchUserRepos,
};
