import { readFile, readdir, stat } from "node:fs/promises";
import { normalizeSiteCatalog, normalizeSiteMetrics, normalizeSitePreview, normalizeSiteRightsReview } from "./curated-site-data.mjs";

const catalogUrl = new URL("../site/catalog.json", import.meta.url);
const catalog = normalizeSiteCatalog(JSON.parse(await readFile(catalogUrl, "utf8")));
const metrics = normalizeSiteMetrics(
  JSON.parse(await readFile(new URL("../site/metrics.json", import.meta.url), "utf8")),
  catalog
);
for (const theme of catalog.themes) {
  const rightsReviewUrl = new URL(theme.rightsReviewUrl);
  const rightsReviewPath = new URL(`../site${rightsReviewUrl.pathname.replace(/^\/PromptDirector-Curated/, "")}`, import.meta.url);
  normalizeSiteRightsReview(JSON.parse(await readFile(rightsReviewPath, "utf8")), theme);
  const previewUrl = new URL(theme.previewUrl);
  const previewPath = new URL(`../site${previewUrl.pathname.replace(/^\/PromptDirector-Curated/, "")}`, import.meta.url);
  const preview = normalizeSitePreview(JSON.parse(await readFile(previewPath, "utf8")), theme);
  for (const entry of preview.entries) {
    const imageUrl = new URL(entry.previewImageUrl);
    const imagePath = new URL(`../site${imageUrl.pathname.replace(/^\/PromptDirector-Curated/, "")}`, import.meta.url);
    const info = await stat(imagePath);
    if (!info.isFile() || info.size < 1) throw new Error(`${theme.id}/${entry.id} 的预览图片缺失`);
  }
}

const siteRoot = new URL("../site/", import.meta.url);
const siteBytes = await directoryBytes(siteRoot);
if (siteBytes > 1_000_000_000) throw new Error("GitHub Pages 站点超过 1GB 限制");

process.stdout.write(`公开目录有效：${catalog.themes.length} 个精选包，${Object.keys(metrics.downloads).length} 组真实下载指标，站点 ${siteBytes} 字节\n`);

async function directoryBytes(directoryUrl) {
  let total = 0;
  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directoryUrl);
    total += entry.isDirectory() ? await directoryBytes(url) : (await stat(url)).size;
  }
  return total;
}
