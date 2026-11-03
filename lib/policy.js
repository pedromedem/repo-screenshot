const { canonicalHomepage } = require("./repos");

const MAX_CAPTURES = 6;

function isBlockedHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");

  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }

  if (host.includes(":")) {
    const bare = host.split("%")[0];
    if (bare === "::" || bare === "::1") return true;
    return /^f[cd]/i.test(bare) || /^fe[89ab]/i.test(bare);
  }

  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;

  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function partitionHomepages(urls) {
  const visible = [];
  const blocked = [];
  for (const url of urls) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      blocked.push(url);
      continue;
    }
    if (isBlockedHost(host)) blocked.push(url);
    else visible.push(url);
  }
  return { visible, blocked };
}

function selectCaptureUrls(available, requested, max = MAX_CAPTURES) {
  const limit = max || MAX_CAPTURES;
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > limit) {
    throw new Error(`Selecione de 1 a ${limit} homepages.`);
  }

  const allowed = new Set(available);
  const selected = [];
  const seen = new Set();

  for (const raw of requested) {
    const canonical = canonicalHomepage(raw, "");
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);

    let hostname = "";
    try {
      hostname = new URL(canonical).hostname;
    } catch {
      throw new Error("Homepage inválida.");
    }
    if (isBlockedHost(hostname)) {
      throw new Error("Essa homepage aponta para um endereço interno e não pode ser capturada pelo servidor.");
    }
    if (!allowed.has(canonical)) {
      throw new Error("Essa URL não está entre as homepages deste usuário.");
    }
    selected.push(canonical);
  }

  if (selected.length === 0) {
    throw new Error(`Selecione de 1 a ${limit} homepages.`);
  }
  return selected;
}

module.exports = {
  MAX_CAPTURES,
  isBlockedHost,
  partitionHomepages,
  selectCaptureUrls,
};
