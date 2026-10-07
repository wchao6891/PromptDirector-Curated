import { normalizeSiteSkillCatalog } from "./skill-catalog.js";

// A page outside the site root (for example /en/) can set window.PD_SITE_ROOT and
// window.PD_SITE_STRINGS; both default to the Chinese site behaviour.
const SITE_ROOT = (typeof window !== "undefined" && window.PD_SITE_ROOT) || "./";
const UI_STRINGS = (typeof window !== "undefined" && window.PD_SITE_STRINGS) || {};
const t = (key, fallback) => UI_STRINGS[key] ?? fallback;
function siteAssetUrl(value) {
  const url = new URL(value, new URL(SITE_ROOT, location.href));
  if (location.hostname === "wchao6891.github.io") return url.href;
  return `${url.pathname.replace(/^\/PromptDirector-Curated/, "")}${url.search}`;
}

const state = { catalog: [], query: "", selected: "" };
const elements = {
  app: document.querySelector("#skill-app"),
  search: document.querySelector("#skill-search"),
  dialog: document.querySelector("#skill-dialog"),
  close: document.querySelector("#skill-close"),
  detail: document.querySelector("#skill-detail")
};

elements.search.addEventListener("input", () => { state.query = elements.search.value.trim().toLocaleLowerCase(); render(); });
elements.close.addEventListener("click", closeDetail);
elements.dialog.addEventListener("click", (event) => { if (event.target === elements.dialog) closeDetail(); });

await start();

async function start() {
  elements.search.disabled = true;
  elements.app.replaceChildren(loading());
  try {
    const response = await fetch(siteAssetUrl("skills-catalog.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`目录返回 HTTP ${response.status}`);
    state.catalog = normalizeSiteSkillCatalog(await response.json()).skills;
    elements.search.disabled = false;
    render();
  } catch (error) {
    elements.app.replaceChildren(statusView({
      state: "error",
      title: t("skillsCatalogFailed", "精选 Skill 目录加载失败"),
      description: t("skillsCatalogFailedDetail", "当前无法读取公开目录，可以稍后重试。"),
      actionLabel: t("retry", "重试"),
      action: start,
      alert: true
    }));
  }
}

function render() {
  if (!state.catalog.length) {
    elements.app.replaceChildren(statusView({
      state: "empty",
      title: t("skillsEmpty", "精选 Skill 目录暂时为空"),
      description: t("skillsEmptyDetail", "通过人工审核的 Skill 会在这里公开展示。"),
      actionLabel: t("browseCases", "浏览精选案例"),
      href: "index.html"
    }));
    return;
  }
  const items = state.catalog.filter((item) => !state.query || [item.title, item.callName, item.author, item.summary].join(" ").toLocaleLowerCase().includes(state.query));
  if (!items.length) {
    elements.app.replaceChildren(statusView({
      state: "search-empty",
      title: t("skillsNoMatch", "没有匹配的精选 Skill"),
      description: t("skillsNoMatchDetail", "换一个关键词，或清除搜索查看全部内容。"),
      actionLabel: t("clearSearch", "清除搜索"),
      action: clearSearch
    }));
    return;
  }
  const grid = element("section", "public-skill-grid");
  grid.append(...items.map(card));
  elements.app.replaceChildren(grid);
}

function card(item) {
  const root = element("article", "ui-skill-card public-skill-card");
  if (item.cover) root.append(coverImage(item));
  root.append(element("h2", "ui-skill-card-title", item.title), element("p", "ui-skill-card-summary", item.summary));
  const actions = element("div", "ui-skill-card-actions public-skill-card-actions");
  const view = element("button", "", t("viewDetails", "查看说明"));
  view.type = "button";
  view.addEventListener("click", () => openDetail(item));
  actions.append(view, downloadLink(item));
  root.append(actions);
  return root;
}

function openDetail(item) {
  state.selected = item.id;
  const root = element("article", "public-skill-detail");
  if (item.cover) root.append(coverImage(item, true));
  root.append(element("h1", "", item.title), element("p", "", item.summary));
  const maintenance = element("details", "public-skill-maintenance");
  maintenance.append(element("summary", "", t("versionLicense", "版本与许可")));
  const maintenanceCopy = element("div", "public-skill-maintenance-copy");
  maintenanceCopy.append(element("span", "", t("skillAuthor", "作者：{value}").replace("{value}", item.author)), element("span", "", t("skillVersion", "版本：{value}").replace("{value}", item.version)), element("span", "", t("skillLicense", "许可：{value}").replace("{value}", item.license)), element("span", "", t("humanReviewed", "人工审核通过")));
  maintenance.append(maintenanceCopy);
  const download = downloadLink(item, "public-skill-download");
  root.append(maintenance, download);
  elements.detail.replaceChildren(root);
  elements.dialog.showModal();
}

function downloadLink(item, className = "") {
  const download = element("a", className, t("downloadSkill", "下载 Skill"));
  download.href = item.downloadUrl;
  download.rel = "noopener";
  return download;
}

function closeDetail() { state.selected = ""; if (elements.dialog.open) elements.dialog.close(); elements.detail.replaceChildren(); }
function clearSearch() { state.query = ""; elements.search.value = ""; render(); elements.search.focus(); }
function loading() {
  const node = element("section", "loading-grid skill-loading");
  node.setAttribute("aria-label", t("skillsLoading", "正在加载精选 Skill"));
  node.append(...Array.from({ length: 4 }, () => element("span")));
  return node;
}
function statusView(options) {
  const node = element("section", "empty-state skill-state curated-skill-state");
  node.dataset.state = options.state;
  if (options.alert) node.setAttribute("role", "alert");
  const copy = element("div", "skill-state-copy curated-skill-state-copy");
  copy.append(element("h2", "", options.title), element("p", "", options.description));
  const actionClass = "skill-state-action curated-skill-state-action";
  const action = options.href ? element("a", actionClass, options.actionLabel) : element("button", actionClass, options.actionLabel);
  if (options.href) action.href = options.href;
  else { action.type = "button"; action.addEventListener("click", options.action); }
  node.append(copy, action);
  return node;
}
function element(tag, className = "", text = "") { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }

function coverImage(item, detail = false) {
  const figure = element("div", detail ? "skill-cover-detail" : "skill-cover-card");
  const image = element("img");
  image.src = siteAssetUrl(item.cover.path);
  image.alt = item.title;
  image.loading = "lazy";
  image.addEventListener("error", () => { figure.textContent = t("coverFailed", "封面读取失败"); }, { once: true });
  figure.append(image);
  return figure;
}
