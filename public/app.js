const searchForm = document.querySelector("#search-form");
const usernameInput = document.querySelector("#username");
const tokenInput = document.querySelector("#token");
const searchButton = document.querySelector("#search-button");
const statusNode = document.querySelector("#status");
const listSection = document.querySelector("#list-section");
const siteList = document.querySelector("#site-list");
const filterInput = document.querySelector("#filter");
const selectionCount = document.querySelector("#selection-count");
const captureButton = document.querySelector("#capture-button");
const resultsSection = document.querySelector("#results-section");
const resultsNode = document.querySelector("#results");

const state = {
  username: "",
  token: "",
  homepages: [],
  selected: new Set(),
  rendered: 0,
  maxCaptures: 6,
};

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  search().catch((error) => setStatus(error.message));
});

document.querySelector("#select-some").addEventListener("click", () => {
  state.selected = new Set(visibleHomepages().slice(0, state.maxCaptures));
  syncChecks();
});

document.querySelector("#clear-selection").addEventListener("click", () => {
  state.selected.clear();
  syncChecks();
});

filterInput.addEventListener("input", renderList);
captureButton.addEventListener("click", () => {
  capture().catch((error) => setStatus(error.message));
});

async function search() {
  const username = usernameInput.value.trim();
  const token = tokenInput.value.trim();
  setBusy(true);
  try {
  setStatus("Buscando repositórios…");
  const data = await request("/api/homepages", { username, token });
  state.username = data.username;
  state.token = token;
  state.homepages = data.homepages;
  state.maxCaptures = Number(data.maxCaptures) || 6;
  document.querySelector("#select-some").textContent = `Selecionar ${state.maxCaptures}`;
  state.selected = new Set(data.homepages.slice(0, 1));
  filterInput.value = "";
  renderList();
  listSection.hidden = false;
  const notes = [`${data.homepages.length} homepage(s).`];
  if (data.truncated) notes.push("A API parou em 1000 repositórios.");
  if (data.blocked) notes.push(`${data.blocked} endereço(s) interno(s) ficaram de fora.`);
  if (data.homepages.length === 0) notes.push("Nenhuma homepage pública nesse usuário.");
  setStatus(notes.join(" "));
  } finally {
    setBusy(false);
  }
}

function visibleHomepages() {
  const query = filterInput.value.trim().toLowerCase();
  if (!query) return state.homepages;
  return state.homepages.filter((url) => url.toLowerCase().includes(query));
}

function renderList() {
  const homepages = visibleHomepages();
  siteList.replaceChildren();
  for (const url of homepages) {
    const item = document.createElement("li");
    const label = document.createElement("label");
    label.className = "site";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selected.has(url);
    checkbox.addEventListener("change", () => toggle(url, checkbox));
    const text = document.createElement("span");
    const host = document.createElement("span");
    host.className = "host";
    host.textContent = new URL(url).hostname;
    const address = document.createElement("span");
    address.className = "url";
    address.textContent = url;
    text.append(host, address);
    label.append(checkbox, text);
    item.append(label);
    siteList.append(item);
  }
  updateSelection();
}

function toggle(url, checkbox) {
  if (checkbox.checked) {
    if (state.selected.size >= state.maxCaptures) {
      checkbox.checked = false;
      setStatus(`Dá para capturar no máximo ${state.maxCaptures} homepage(s) por vez.`);
      return;
    }
    state.selected.add(url);
  } else {
    state.selected.delete(url);
  }
  updateSelection();
}

function syncChecks() {
  renderList();
}

function updateSelection() {
  const count = state.selected.size;
  selectionCount.textContent = count === 0
    ? "Nenhum site selecionado"
    : `${count} de no máximo ${state.maxCaptures} selecionado(s)`;
  captureButton.disabled = count === 0;
  captureButton.textContent = count === 0 ? "Capturar" : `Capturar ${count}`;
}

async function capture() {
  const urls = state.homepages.filter((url) => state.selected.has(url));
  setBusy(true);
  captureButton.disabled = true;
  state.rendered = 0;
  resultsNode.replaceChildren();
  resultsSection.hidden = false;
  setStatus("Abrindo o navegador…");
  try {
    const job = await request("/api/jobs", {
      username: state.username,
      token: state.token,
      urls,
    });
    if (job.status === "done" || job.status === "error") paintJob(job);
    else await poll(job.id);
  } finally {
    setBusy(false);
    updateSelection();
  }
}

async function poll(id) {
  const started = Date.now();
  while (Date.now() - started < 12 * 60 * 1000) {
    const job = await request(`/api/jobs/${id}`);
    paintJob(job);
    if (job.status === "done" || job.status === "error") return;
    await delay(800);
  }
  setStatus("A captura passou do tempo limite da página. Atualize e tente de novo.");
}

function paintJob(job) {
  if (job.status === "error") {
    setStatus(job.error || "A captura falhou.");
  } else if (job.status === "done") {
    const failed = job.results.filter((item) => item.desktopError || item.mobileError).length;
    setStatus(failed ? `Concluído com falha em ${failed} site(s).` : "Capturas prontas.");
  } else {
    setStatus(`Capturando ${job.completed} de ${job.total}…`);
  }

  for (let index = state.rendered; index < job.results.length; index += 1) {
    resultsNode.append(shotCard(job.results[index]));
  }
  state.rendered = job.results.length;
}

function shotCard(result) {
  const article = document.createElement("article");
  article.className = "shot";
  const head = document.createElement("div");
  head.className = "shot-head";
  const title = document.createElement("h3");
  title.className = "host";
  title.textContent = result.host;
  const link = document.createElement("a");
  link.href = result.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Abrir site";
  head.append(title, link);
  const frames = document.createElement("div");
  frames.className = "frames";
  frames.append(
    frame("Desktop", result.host, result.desktop, result.desktopError),
    frame("Mobile", result.host, result.mobile, result.mobileError)
  );
  article.append(head, frames);
  return article;
}

function frame(label, host, src, error) {
  const figure = document.createElement("figure");
  const caption = document.createElement("figcaption");
  caption.textContent = label;
  figure.append(caption);
  if (src) {
    const image = document.createElement("img");
    image.src = src;
    image.alt = `Print ${label.toLowerCase()} de ${host}`;
    figure.append(image);
  } else {
    const message = document.createElement("p");
    message.className = "frame-error";
    message.textContent = error || "Sem imagem.";
    figure.append(message);
  }
  return figure;
}

async function request(url, body) {
  const response = await fetch(url, body
    ? {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
    : undefined);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Erro ${response.status}`);
  return data;
}

function setStatus(message) {
  statusNode.textContent = message;
}

function setBusy(busy) {
  searchButton.disabled = busy;
  usernameInput.disabled = busy;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
