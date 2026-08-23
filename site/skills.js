import { normalizeSiteSkillCatalog } from "./skill-catalog.js";

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
    const response = await fetch("skills-catalog.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`目录返回 HTTP ${response.status}`);
    state.catalog = normalizeSiteSkillCatalog(await response.json()).skills;
    elements.search.disabled = false;
    render();
  } catch (error) {
    elements.app.replaceChildren(statusView({
      state: "error",
      title: "精选 Skill 目录加载失败",
      description: "当前无法读取公开目录，可以稍后重试。",
      actionLabel: "重试",
      action: start,
      alert: true
    }));
  }
}

function render() {
  if (!state.catalog.length) {
    elements.app.replaceChildren(statusView({
      state: "empty",
      title: "精选 Skill 目录暂时为空",
      description: "通过人工审核的 Skill 会在这里公开展示。",
      actionLabel: "浏览精选案例",
      href: "index.html"
    }));
    return;
  }
  const items = state.catalog.filter((item) => !state.query || [item.title, item.callName, item.author, item.summary].join(" ").toLocaleLowerCase().includes(state.query));
  if (!items.length) {
    elements.app.replaceChildren(statusView({
      state: "search-empty",
      title: "没有匹配的精选 Skill",
      description: "换一个关键词，或清除搜索查看全部内容。",
      actionLabel: "清除搜索",
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
  root.append(element("h2", "ui-skill-card-title", item.title), element("p", "ui-skill-card-summary", item.summary));
  const actions = element("div", "ui-skill-card-actions public-skill-card-actions");
  const view = element("button", "", "查看说明");
  view.type = "button";
  view.addEventListener("click", () => openDetail(item));
  actions.append(view, downloadLink(item));
  root.append(actions);
  return root;
}

function openDetail(item) {
  state.selected = item.id;
  const root = element("article", "public-skill-detail");
  root.append(element("h1", "", item.title), element("p", "", item.summary));
  const maintenance = element("details", "public-skill-maintenance");
  maintenance.append(element("summary", "", "版本与许可"));
  const maintenanceCopy = element("div", "public-skill-maintenance-copy");
  maintenanceCopy.append(element("span", "", `作者：${item.author}`), element("span", "", `版本：${item.version}`), element("span", "", `许可：${item.license}`), element("span", "", "人工审核通过"));
  maintenance.append(maintenanceCopy);
  const download = downloadLink(item, "public-skill-download");
  root.append(maintenance, download);
  elements.detail.replaceChildren(root);
  elements.dialog.showModal();
}

function downloadLink(item, className = "") {
  const download = element("a", className, "下载 Skill");
  download.href = item.downloadUrl;
  download.rel = "noopener";
  return download;
}

function closeDetail() { state.selected = ""; if (elements.dialog.open) elements.dialog.close(); elements.detail.replaceChildren(); }
function clearSearch() { state.query = ""; elements.search.value = ""; render(); elements.search.focus(); }
function loading() {
  const node = element("section", "loading-grid skill-loading");
  node.setAttribute("aria-label", "正在加载精选 Skill");
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
