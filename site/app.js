import { createStableMasonry } from "./masonry.js";

const CATALOG_URL = "catalog.json";
const METRICS_URL = "metrics.json";
const FOLLOW_STORAGE_KEY = "promptdirector.curated.following.v1";
const CASE_PAGE_SIZE = 24;

const state = {
  catalog: [],
  previews: new Map(),
  previewFailures: new Set(),
  metrics: null,
  query: "",
  filters: new Set(),
  sort: "recommended",
  following: readFollowing(),
  selectedId: "",
  selectedEntryId: ""
};

const elements = Object.fromEntries([
  "app", "case-detail-backdrop", "case-detail-close", "case-detail-content", "case-detail-drawer", "case-detail-next", "case-detail-prev",
  "clear-filters", "detail-close", "detail-content", "detail-dialog", "filter-button", "filter-count", "filter-popover",
  "search-input", "sort-downloads", "sort-label", "sort-menu", "toast"
].map((id) => [camel(id), document.querySelector(`#${id}`)]));

let toastTimer = 0;
let searchVersion = 0;
let detailReturnFocus = null;
let caseDetailReturnFocus = null;
let caseMasonry = null;
let caseLoadObserver = null;
let renderedCaseCount = 0;
const caseVideoControllers = new Set();
let caseDetailVideoCleanup = null;

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
  if (state.selectedEntryId) closeCaseDetail();
  else closeDetail();
});
elements.caseDetailBackdrop.addEventListener("click", closeCaseDetail);
elements.caseDetailClose.addEventListener("click", closeCaseDetail);
elements.caseDetailPrev.addEventListener("click", () => moveCaseDetail(-1));
elements.caseDetailNext.addEventListener("click", () => moveCaseDetail(1));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".filter-wrap")) {
    elements.filterPopover.hidden = true;
    elements.filterButton.setAttribute("aria-expanded", "false");
  }
  if (!event.target.closest(".sort-menu")) elements.sortMenu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (state.selectedEntryId && !event.target.matches("input, textarea, select")) {
    if (event.key === "ArrowLeft") moveCaseDetail(-1);
    if (event.key === "ArrowRight") moveCaseDetail(1);
  }
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
    renderCatalogFailure();
  }
}

async function loadMetrics() {
  try {
    const response = await fetch(METRICS_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`指标返回 HTTP ${response.status}`);
    const metrics = await response.json();
    if (metrics?.format !== "prompt-director-curated-metrics" || metrics.version !== 1 || !metrics.downloads) throw new Error("指标格式无效");
    if (state.catalog.some((item) => !Number.isSafeInteger(metrics.downloads[item.id]) || metrics.downloads[item.id] < 0)) throw new Error("下载指标不完整");
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
  if (!items.length) {
    elements.app.replaceChildren(emptyState("没有结果"));
    return;
  }
  const grid = element("section", "pack-grid");
  grid.append(...items.map(createPackCard));
  elements.app.replaceChildren(grid);
}

function visibleItems() {
  let items = state.catalog.filter((item) => {
    if (state.filters.has("followed") && !state.following.has(item.authorId)) return false;
    const typeFilters = [...state.filters].filter((value) => value !== "followed");
    if (typeFilters.length && !typeFilters.includes(item.type)) return false;
    return !state.query || searchableText(item).includes(state.query);
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
  return [item.title, item.author, ...(preview?.entries ?? []).flatMap((entry) => [entry.title, entry.author, entry.text])]
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
  const open = () => openDetail(item.id, card);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    open();
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
  if (!elements.detailDialog.open) elements.detailDialog.showModal();
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
  if (state.selectedEntryId) closeCaseDetail({ restoreFocus: false });
  const selectedId = state.selectedId;
  const returnFocus = detailReturnFocus;
  cleanupCaseGallery();
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
  cleanupCaseGallery();
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
  follow.addEventListener("click", () => toggleFollow(item, follow));
  const copyLink = element("button", "", "复制链接");
  copyLink.type = "button";
  copyLink.addEventListener("click", () => copyText(publicPackUrl(item.id), copyLink, "已复制"));
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
    const sentinel = element("div", "case-load-sentinel");
    section.append(list, sentinel);
    surface.append(section);
    elements.detailContent.replaceChildren(surface);
    startCaseGallery(item, preview, list, sentinel);
    return;
  }
  if (failed) {
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

function startCaseGallery(item, preview, list, sentinel) {
  renderedCaseCount = 0;
  caseMasonry = createStableMasonry(list, { scrollContainer: elements.detailDialog });
  const appendNext = () => {
    const entries = preview.entries.slice(renderedCaseCount, renderedCaseCount + CASE_PAGE_SIZE);
    if (!entries.length) return;
    const cards = entries.map((entry) => createCaseCard(item, entry));
    list.append(...cards);
    caseMasonry.append(cards);
    renderedCaseCount += entries.length;
    sentinel.hidden = renderedCaseCount >= preview.entries.length;
    if (sentinel.hidden) caseLoadObserver?.disconnect();
  };
  appendNext();
  if (renderedCaseCount < preview.entries.length) {
    caseLoadObserver = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) appendNext();
    }, { root: elements.detailDialog, rootMargin: "600px 0px" });
    caseLoadObserver.observe(sentinel);
  }
}

function cleanupCaseGallery() {
  caseLoadObserver?.disconnect();
  caseLoadObserver = null;
  caseMasonry?.destroy();
  caseMasonry = null;
  for (const controller of caseVideoControllers) controller.destroy();
  caseVideoControllers.clear();
  renderedCaseCount = 0;
}

function createCaseCard(item, entry) {
  const card = element("article", "case-card");
  card.dataset.entryId = entry.id;
  card.tabIndex = 0;
  card.setAttribute("aria-label", `查看案例：${entry.title}`);
  const visual = element("div", "case-image-wrap");
  visual.style.aspectRatio = `${entry.width} / ${entry.height}`;
  const image = element("img", "case-visual");
  image.src = siteAssetUrl(entry.previewImageUrl);
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  image.width = entry.width;
  image.height = entry.height;
  visual.append(image);
  if (entry.mediaKind === "video") {
    visual.append(element("span", "case-video-badge", "▶"));
    if (entry.videoUrl) caseVideoControllers.add(bindRemoteVideoHover(visual, entry));
  }
  card.append(visual);
  const open = () => openCaseDetail(item, entry, card);
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (!["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    open();
  });
  return card;
}

function openCaseDetail(item, entry, card) {
  state.selectedEntryId = entry.id;
  caseDetailReturnFocus = card ?? caseDetailReturnFocus;
  elements.caseDetailBackdrop.hidden = false;
  elements.caseDetailDrawer.classList.add("open");
  elements.caseDetailDrawer.setAttribute("aria-hidden", "false");
  setPackageDetailInert(true);
  renderCaseDetail(item, entry);
  elements.caseDetailClose.focus({ preventScroll: true });
}

function closeCaseDetail({ restoreFocus = true } = {}) {
  const returnFocus = caseDetailReturnFocus;
  state.selectedEntryId = "";
  caseDetailReturnFocus = null;
  elements.caseDetailDrawer.classList.remove("open");
  elements.caseDetailDrawer.setAttribute("aria-hidden", "true");
  setPackageDetailInert(false);
  elements.caseDetailBackdrop.hidden = true;
  caseDetailVideoCleanup?.();
  caseDetailVideoCleanup = null;
  elements.caseDetailContent.replaceChildren();
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

function moveCaseDetail(offset) {
  const item = state.catalog.find((candidate) => candidate.id === state.selectedId);
  const preview = item ? state.previews.get(item.id) : null;
  if (!item || !preview) return;
  const index = preview.entries.findIndex((entry) => entry.id === state.selectedEntryId);
  const entry = preview.entries[index + offset];
  if (!entry) return;
  state.selectedEntryId = entry.id;
  renderCaseDetail(item, entry);
}

function renderCaseDetail(item, entry) {
  caseDetailVideoCleanup?.();
  caseDetailVideoCleanup = null;
  const preview = state.previews.get(item.id);
  const index = preview.entries.findIndex((candidate) => candidate.id === entry.id);
  elements.caseDetailPrev.disabled = index <= 0;
  elements.caseDetailNext.disabled = index >= preview.entries.length - 1;
  const layout = element("article", "case-detail-layout");
  const figure = element("figure", "case-detail-figure");
  if (entry.mediaKind === "video" && entry.videoUrl) {
    const player = createRemoteVideoPlayer(entry);
    figure.append(player.node);
    caseDetailVideoCleanup = player.destroy;
  } else {
    figure.append(createRemoteImageViewer(entry, siteAssetUrl(entry.previewImageUrl)));
    if (entry.mediaKind === "video") figure.append(element("span", "case-detail-video-label", "视频暂不可播放"));
  }
  const body = element("div", "case-detail-body");
  const heading = element("header", "case-detail-heading");
  heading.append(element("h2", "", entry.title), element("p", "", entry.author));
  body.append(heading);
  const prompt = element("section", "case-detail-section");
  prompt.append(element("h3", "", "完整提示词"), element("pre", "case-detail-prompt", entry.text));
  body.append(prompt);
  const source = element("div", "case-detail-source");
  source.append(element("span", "", entry.rights || rightsLabel(item.license)));
  if (entry.sourceUrl) {
    const link = element("a", "", "查看来源");
    link.href = entry.sourceUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    source.append(link);
  }
  body.append(source);
  const actions = element("div", "case-detail-actions");
  const copy = element("button", "", "复制提示词");
  copy.type = "button";
  copy.disabled = !entry.text;
  copy.addEventListener("click", () => copyText(entry.text, copy, "已复制"));
  actions.append(copy);
  body.append(actions);
  layout.append(figure, body);
  elements.caseDetailContent.replaceChildren(layout);
}

async function loadPreview(item) {
  if (state.previews.has(item.id)) return state.previews.get(item.id);
  if (state.previewFailures.has(item.id)) throw new Error("预览先前加载失败");
  try {
    const response = await fetch(siteAssetUrl(item.previewUrl), { cache: "no-cache" });
    if (!response.ok) throw new Error(`预览返回 HTTP ${response.status}`);
    const preview = await response.json();
    if (preview?.format !== "prompt-director-curated-preview" || preview.version !== 1 || preview.catalogId !== item.id || preview.packageId !== item.packageId || preview.packageVersion !== item.packageVersion || !Array.isArray(preview.entries) || preview.entries.length !== item.caseCount) throw new Error("预览格式无效");
    preview.entries = preview.entries.map(normalizePreviewEntry);
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

function normalizePreviewEntry(entry) {
  const next = { ...entry };
  const hasVideoAsset = Boolean(String(next.videoUrl ?? "").trim() || String(next.videoSha256 ?? "").trim() || String(next.videoMimeType ?? "").trim() || Number(next.videoBytes) > 0);
  if (!hasVideoAsset) {
    delete next.videoUrl;
    delete next.videoSha256;
    delete next.videoBytes;
    delete next.videoMimeType;
    return next;
  }
  const url = new URL(next.videoUrl);
  const trustedHosts = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
  if (next.mediaKind !== "video" || url.protocol !== "https:" || !trustedHosts.has(url.hostname) || url.username || url.password || url.search || url.hash ||
      !/^[a-f0-9]{64}$/.test(next.videoSha256) || !Number.isSafeInteger(next.videoBytes) || next.videoBytes < 1 || next.videoMimeType !== "video/mp4") {
    throw new Error("精选视频预览无效");
  }
  return next;
}

function bindRemoteVideoHover(container, entry) {
  let video = null;
  const canPlay = () => !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
    && globalThis.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches;
  const destroy = () => {
    if (!video) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    video = null;
    container.classList.remove("is-video-playing", "is-video-loading");
  };
  const start = async () => {
    if (!canPlay() || video) return;
    container.classList.add("is-video-loading");
    video = document.createElement("video");
    video.className = "case-video-preview";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.poster = siteAssetUrl(entry.previewImageUrl);
    video.src = entry.videoUrl;
    video.setAttribute("aria-hidden", "true");
    video.addEventListener("playing", () => {
      container.classList.remove("is-video-loading");
      container.classList.add("is-video-playing");
    }, { once: true });
    video.addEventListener("error", () => {
      destroy();
      container.classList.add("is-video-preview-unavailable");
    }, { once: true });
    container.append(video);
    await video.play().catch(() => destroy());
  };
  container.addEventListener("pointerenter", start);
  container.addEventListener("pointerleave", destroy);
  return {
    destroy() {
      container.removeEventListener("pointerenter", start);
      container.removeEventListener("pointerleave", destroy);
      destroy();
    }
  };
}

function createRemoteVideoPlayer(entry) {
  const video = document.createElement("video");
  video.className = "case-detail-video";
  video.controls = true;
  video.preload = "metadata";
  video.autoplay = false;
  video.playsInline = true;
  video.poster = siteAssetUrl(entry.previewImageUrl);
  video.src = entry.videoUrl;
  video.style.aspectRatio = `${entry.width} / ${entry.height}`;
  const failure = element("div", "case-video-error");
  failure.hidden = true;
  failure.append(element("span", "", "视频加载失败"));
  const retry = element("button", "", "重试");
  retry.type = "button";
  retry.addEventListener("click", () => {
    failure.hidden = true;
    video.src = entry.videoUrl;
    video.load();
  });
  failure.append(retry);
  video.addEventListener("error", () => { failure.hidden = false; });
  const wrap = element("div", "case-detail-video-wrap");
  wrap.append(video, failure);
  return {
    node: wrap,
    destroy() {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  };
}

function createRemoteImageViewer(entry, url) {
  const image = element("img");
  image.alt = entry.title;
  image.width = entry.width;
  image.height = entry.height;
  const failure = element("div", "case-video-error");
  failure.hidden = true;
  failure.append(element("span", "", "图片加载失败"));
  const retry = element("button", "", "重试");
  retry.type = "button";
  retry.addEventListener("click", () => {
    failure.hidden = true;
    image.removeAttribute("src");
    requestAnimationFrame(() => { image.src = url; });
  });
  failure.append(retry);
  image.addEventListener("error", () => { failure.hidden = false; });
  image.src = url;
  const fragment = document.createDocumentFragment();
  fragment.append(image, failure);
  return fragment;
}

function setPackageDetailInert(inert) {
  elements.detailContent.inert = inert;
  elements.detailClose.inert = inert;
}

function toggleFollow(item, button) {
  if (state.following.has(item.authorId)) state.following.delete(item.authorId);
  else state.following.add(item.authorId);
  localStorage.setItem(FOLLOW_STORAGE_KEY, JSON.stringify([...state.following]));
  updateFilters();
  const following = state.following.has(item.authorId);
  if (button) {
    button.classList.toggle("is-active", following);
    button.textContent = following ? "已关注" : "关注";
  }
}

function renderCatalogFailure() {
  const failure = emptyState("");
  failure.append(element("span", "", "精选目录加载失败"));
  const retry = element("button", "", "重试");
  retry.type = "button";
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    await start();
  });
  failure.append(retry);
  elements.app.replaceChildren(failure);
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

async function copyText(value, button, successLabel) {
  const originalLabel = button?.textContent ?? "";
  try {
    await navigator.clipboard.writeText(value);
    if (button) {
      button.textContent = successLabel;
      button.classList.add("is-success");
      setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = originalLabel;
        button.classList.remove("is-success");
      }, 1600);
    }
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

function camel(value) {
  return value.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}
