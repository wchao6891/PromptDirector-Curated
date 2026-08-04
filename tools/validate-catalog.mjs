import { readFile } from "node:fs/promises";

const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
if (catalog?.format !== "prompt-director-curated" || catalog.version !== 2 || !Array.isArray(catalog.themes)) {
  throw new Error("catalog.json 格式无效");
}
if (!Number.isFinite(Date.parse(catalog.updatedAt))) throw new Error("目录更新时间无效");

const ids = new Set();
const packages = new Set();
const orders = new Set();
for (const item of catalog.themes) {
  const required = ["id", "title", "type", "packageId", "packageVersion", "author", "license", "updatedAt", "coverUrl", "downloadUrl", "sha256", "order"];
  if (required.some((key) => !String(item?.[key] ?? "").trim())) throw new Error("目录条目缺少必填字段");
  if (!["editorial", "image_prompt", "video_prompt"].includes(item.type)) throw new Error(`不支持的精选类型：${item.type}`);
  if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`校验值无效：${item.id}`);
  if (![item.caseCount, item.imageCount].every((value) => Number.isInteger(value) && value >= 0)) {
    throw new Error(`案例或图片数量无效：${item.id}`);
  }
  for (const urlValue of [item.coverUrl, item.downloadUrl]) {
    const url = new URL(urlValue);
    if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) {
      throw new Error(`精选地址无效：${item.id}`);
    }
  }
  const packageKey = `${item.packageId}@${item.packageVersion}`;
  if (!Number.isInteger(item.order) || item.order < 1 || orders.has(item.order)) throw new Error(`主题排序无效：${item.id}`);
  if (ids.has(item.id) || packages.has(packageKey)) throw new Error(`精选编号重复：${item.id}`);
  ids.add(item.id);
  orders.add(item.order);
  packages.add(packageKey);
}

process.stdout.write(`catalog.json 有效：${catalog.themes.length} 个精选主题\n`);
