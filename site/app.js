const CATALOG_URL = "catalog.json";
const METRICS_URL = "metrics.json";
const FOLLOW_STORAGE_KEY = "promptdirector.curated.following.v1";

const state = {
  catalog: [],
  previews: new Map(),
  previewFailures: new Set(),
  metrics: null,
  query: "",
  filters: new Set(),
  sort: "recommended",
  following: readFollowing(),
  selectedId: ""
};

const elements = {
  app: document.querySelector("#app"),
  clearFilters: document.querySelector("#clear-filters"),
  detailClose: document.querySelector("#detail-close"),
  detailContent: document.querySelector("#detail-content"),
  detailDialog: document.querySelector("#detail-dialog"),
  filterButton: document.querySelector("#filter-button"),
  filterCount: document.querySelector("#filter-count"),
  filterPopover: document.querySelector("#filter-popover"),
  followedFilter: document.querySelector("#followed-filter"),
  searchInput: document.querySelector("#search-input"),
  sortDownloads: document.querySelector("#sort-downloads"),
  sortLabel: document.querySelector("#sort-label"),
  sortMenu: document.querySelector("#sort-menu"),
  toast: document.querySelector("#toast")
};

let toastTimer = 0;
let searchVersion = 0;
let detailReturnFocus = null;

elements.searchInput.addEventListener("input", async () => {
  const version = ++searchVersion;
  state.query = elements.searchInput.value.trim().toLocaleLowerCase();
  renderGallery();
  if (!state.query) return;
  await loadAllPreviews();
  if (version === searchVersion) renderGallery();
});
elements.filterButton.addEventListener("click", () => {
  elements.filterPopover.hidden = !elements.filterPopover.hidden;
  elements.filterButton.setAttribute("aria-expanded", String(!elements.filterPopover.hidden));
});
elements.filterPopover.addEventListener("change", updateFilters);
elements.clearFilters.addEventListener("click", () => {
  elements.filterPopover.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
  state.filters.clear();
  updateFilterCount();
  renderGallery();
});
elements.sortMenu.addEventListener("click", (event) => {
  const button = event.target.closest("[data-sort]");
  if (!button || button.disabled) return;
  state.sort = button.dataset.sort;
  elements.sortLabel.textContent = button.firstChild.textContent;
  elements.sortMenu.querySelectorAll("[data-sort]").forEach((candidate) => {
    candidate.setAttribute("aria-current", String(candidate === button));
  });
  elements.sortMenu.open = false;
  renderGallery();
});
elements.detailClose.addEventListener("click", closeDetail);
elements.detailDialog.addEventListener("click", (event) => {
  if (event.target === elements.detailDialog) closeDetail();
});
elements.detailDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDetail();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".filter-wrap")) {
    elements.filterPopover.hidden = true;
    elements.filterButton.setAttribute("aria-expanded", "false");
  }
  if (!event.target.closest(".sort-menu")) elements.sortMenu.open = false;
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
    event.preventDefault();
    elements.searchInput.focus();
  }
});

await start();

async function start() {
  try {
    const catalogResponse = await fetch(CATALOG_URL, { cache: "no-store" });
    if (!catalogResponse.ok) throw new Error(`目录返回 HTTP ${catalogResponse.status}`);
    const catalog = await catalogResponse.json();
    if (catalog?.format !== "prompt-director-curated" || catalog.version !== 2 || !Array.isArray(catalog.themes)) {
      throw new Error("目录格式无效");
    }
    state.catalog = catalog.themes;
    renderGallery();
    loadMetrics();
    const requestedId = new URLSearchParams(location.search).get("pack");
    if (requestedId) openDetail(requestedId);
  } catch (error) {
    console.error(error);
    elements.app.replaceChildren(emptyState("加载失败"));
  }
}

async function loadMetrics() {
  try {
    const response = await fetch(METRICS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`指标返回 HTTP ${response.status}`);
    const metrics = await response.json();
    if (metrics?.format !== "prompt-director-curated-metrics" || metrics.version !== 1 || !metrics.downloads) {
      throw new Error("指标格式无效");
    }
    if (state.catalog.some((item) => !Number.isSafeInteger(metrics.downloads[item.id]) || metrics.downloads[item.id] < 0)) {
      throw new Error("下载指标不完整");
    }
    state.metrics = metrics;
    elements.sortDownloads.disabled = false;
    renderGallery();
  } catch (error) {
    console.warn(error);
    state.metrics = null;
    elements.sortDownloads.disabled = true;
  }
}

function renderGallery() {
  const items = visibleItems();
  if (!items.length) return elements.app.replaceChildren(emptyState("没有结果"));
  const grid = element("section", "pack-grid");
  grid.append(...items.map(createPackCard));
  elements.app.replaceChildren(grid);
}

function visibleItems() {
  let items = state.catalog.filter((item) => {
    if (state.filters.has("followed") && !state.following.has(item.authorId)) return false;
    const typeFilters = [...state.filters].filter((value) => value !== "followed");
    if (typeFilters.length && !typeFilters.includes(item.type)) return false;
    if (!state.query) return true;
    return searchableText(item).includes(state.query);
  });
  if (state.sort === "latest") {
    items = [...items].sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt) || left.order - right.order);
  } else if (state.sort === "downloads" && state.metrics) {
    items = [...items].sort((left, right) => state.metrics.downloads[right.id] - state.metrics.downloads[left.id] || left.order - right.order);
  } else {
    items = [...items].sort((left, right) => left.order - right.order);
  }
  return items;
}

function searchableText(item) {
  const preview = state.previews.get(item.id);
  return [item.title, item.author, item.summary, ...(preview?.entries ?? []).flatMap((entry) => [entry.title, entry.author, entry.text])]
    .join(" ")
    .toLocaleLowerCase();
}

function createPackCard(item) {
  const card = element("article", "pack-card");
  card.dataset.packId = item.id;
  card.tabIndex = 0;
  card.setAttribute("aria-label", `打开 ${item.title}`);
  const cover = element("span", "pack-cover");
  const image = element("img");
  image.src = siteAssetUrl(item.coverUrl);
  image.alt = "";
  image.loading = "lazy";
  cover.append(image);
  const copy = element("div", "pack-copy");
  copy.append(element("h2", "", item.title));
  const meta = element("div", "pack-meta");
  meta.append(element("span", "", item.author), element("span", "", `${item.caseCount} 个案例`));
  copy.append(meta);
  card.append(cover, copy);
  card.addEventListener("click", () => openDetail(item.id, card));
  card.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    openDetail(item.id, card);
  });
  return card;
}

async function openDetail(id, returnFocus = null) {
  const item = state.catalog.find((candidate) => candidate.id === id);
  if (!item) return showToast("案例包不存在");
  state.selectedId = item.id;
  if (returnFocus) detailReturnFocus = returnFocus;
  const url = new URL(location.href);
  url.searchParams.set("pack", item.id);
  history.replaceState(null, "", url);
  renderDetail(item, null);
  document.documentElement.classList.add("detail-open");
  elements.detailDialog.showModal();
  elements.detailClose.focus({ preventScroll: true });
  try {
    const preview = await loadPreview(item);
    if (state.selectedId === item.id) renderDetail(item, preview);
  } catch (error) {
    console.error(error);
    showToast("预览加载失败");
    if (state.selectedId === item.id) renderDetail(item, null, true);
  }
}

function closeDetail() {
  const selectedId = state.selectedId;
  const returnFocus = detailReturnFocus;
  state.selectedId = "";
  detailReturnFocus = null;
  document.documentElement.classList.remove("detail-open");
  if (elements.detailDialog.open) elements.detailDialog.close();
  elements.detailContent.replaceChildren();
  const url = new URL(location.href);
  url.searchParams.delete("pack");
  history.replaceState(null, "", url);
  if (returnFocus?.isConnected) returnFocus.focus();
  else [...elements.app.querySelectorAll(".pack-card")].find((card) => card.dataset.packId === selectedId)?.focus();
}

function renderDetail(item, preview, failed = false) {
  const surface = element("article", "detail-surface");
  const hero = element("section", "detail-hero");
  const cover = element("div", "detail-cover");
  const coverImage = element("img");
  coverImage.src = siteAssetUrl(item.coverUrl);
  coverImage.alt = "";
  cover.append(coverImage);
  const info = element("div", "detail-info");
  info.append(element("h1", "", item.title));
  const meta = element("div", "detail-meta");
  meta.append(element("span", "", item.author), element("span", "", `${item.caseCount} 个案例`), element("span", "", rightsLabel(item.license)));
  info.append(meta);
  const actions = element("div", "detail-actions");
  const download = element("a", "", "下载包");
  download.href = item.downloadUrl;
  download.rel = "noopener";
  const following = state.following.has(item.authorId);
  const follow = element("button", `follow-action${following ? " is-active" : ""}`, following ? "已关注" : "关注");
  follow.type = "button";
  follow.addEventListener("click", () => toggleFollow(item));
  const copyLink = element("button", "", "复制链接");
  copyLink.type = "button";
  copyLink.addEventListener("click", () => copyText(publicPackUrl(item.id), "已复制链接"));
  actions.append(download, follow, copyLink);
  info.append(actions);
  hero.append(cover, info);
  surface.append(hero);
  const section = element("section", "case-section");
  const heading = element("h2", "", "包内案例");
  heading.append(element("span", "", String(item.caseCount)));
  section.append(heading);
  if (preview) {
    const list = element("div", "case-list");
    list.append(...preview.entries.map(createCaseCard));
    section.append(list);
  } else if (failed) {
    const failure = element("div", "preview-failure");
    failure.append(element("span", "", "预览加载失败"));
    const retry = element("button", "", "重试");
    retry.type = "button";
    retry.addEventListener("click", () => retryPreview(item, retry));
    failure.append(retry);
    section.append(failure);
  } else {
    const loading = element("div", "case-loading");
    loading.setAttribute("aria-label", "正在加载包内案例");
    section.append(loading);
  }
  surface.append(section);
  elements.detailContent.replaceChildren(surface);
}

function createCaseCard(entry) {
  const card = element("article", "case-card");
  const image = element("img", "case-visual");
  image.src = siteAssetUrl(entry.previewImageUrl);
  image.alt = "";
  image.loading = "lazy";
  image.width = entry.width;
  image.height = entry.height;
  const footer = element("div", "case-footer");
  const copy = element("div", "case-copy");
  copy.append(element("h3", "", entry.title), element("p", "", entry.author));
  const action = element("button", "case-copy-action", "复制");
  action.type = "button";
  action.setAttribute("aria-label", `复制 ${entry.title} 的提示词`);
  action.addEventListener("click", () => copyText(entry.text, "已复制"));
  footer.append(copy, action);
  card.append(image, footer);
  return card;
}

async function loadPreview(item) {
  if (state.previews.has(item.id)) return state.previews.get(item.id);
  if (state.previewFailures.has(item.id)) throw new Error("预览先前加载失败");
  try {
    const response = await fetch(siteAssetUrl(item.previewUrl), { cache: "force-cache" });
    if (!response.ok) throw new Error(`预览返回 HTTP ${response.status}`);
    const preview = await response.json();
    if (preview?.format !== "prompt-director-curated-preview" || preview.version !== 1 || preview.catalogId !== item.id || preview.packageId !== item.packageId || preview.packageVersion !== item.packageVersion || !Array.isArray(preview.entries) || preview.entries.length !== item.caseCount) {
      throw new Error("预览格式无效");
    }
    state.previews.set(item.id, preview);
    return preview;
  } catch (error) {
    state.previewFailures.add(item.id);
    throw error;
  }
}

async function loadAllPreviews() {
  await Promise.allSettled(state.catalog.map(loadPreview));
}

async function retryPreview(item, button) {
  button.disabled = true;
  state.previewFailures.delete(item.id);
  renderDetail(item, null);
  try {
    const preview = await loadPreview(item);
    if (state.selectedId === item.id) renderDetail(item, preview);
  } catch (error) {
    console.error(error);
    showToast("预览加载失败");
    if (state.selectedId === item.id) renderDetail(item, null, true);
  }
}

function toggleFollow(item) {
  if (state.following.has(item.authorId)) state.following.delete(item.authorId);
  else state.following.add(item.authorId);
  localStorage.setItem(FOLLOW_STORAGE_KEY, JSON.stringify([...state.following]));
  showToast(state.following.has(item.authorId) ? "已关注" : "已取消关注");
  updateFilters();
  const preview = state.previews.get(item.id) ?? null;
  if (elements.detailDialog.open) renderDetail(item, preview, state.previewFailures.has(item.id));
}

function updateFilters() {
  state.filters = new Set([...elements.filterPopover.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value));
  updateFilterCount();
  renderGallery();
}

function updateFilterCount() {
  elements.filterCount.textContent = state.filters.size ? ` ${state.filters.size}` : "";
}

function readFollowing() {
  try {
    const value = JSON.parse(localStorage.getItem(FOLLOW_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function rightsLabel(license = "") {
  if (license.includes("PromptDirector 原创")) return "PromptDirector 原创";
  if (license.includes("权利归原作者")) return "权利归原作者";
  return license || "权利未标注";
}

function publicPackUrl(id) {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("pack", id);
  return url.href;
}

function siteAssetUrl(value) {
  const url = new URL(value, location.href);
  if (location.hostname === "wchao6891.github.io") return url.href;
  return `${url.pathname.replace(/^\/PromptDirector-Curated/, "")}${url.search}`;
}

async function copyText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    showToast(message);
  } catch {
    showToast("浏览器未允许复制");
  }
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 2400);
}

function emptyState(message) {
  return element("div", "empty-state", message);
}

function element(tagName, className = "", text = "") {
  const value = document.createElement(tagName);
  if (className) value.className = className;
  if (text) value.textContent = text;
  return value;
}
