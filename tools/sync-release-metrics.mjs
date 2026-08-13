import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSiteCatalog, normalizeSiteMetrics } from "./curated-site-data.mjs";

export async function syncReleaseMetrics({ catalogPath, metricsPath, fetchImpl = fetch, now = new Date() }) {
  const catalog = normalizeSiteCatalog(JSON.parse(await readFile(resolve(catalogPath), "utf8")));
  const response = await fetchImpl("https://api.github.com/repos/wchao6891/PromptDirector-Curated/releases?per_page=100", {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!response.ok) throw new Error(`GitHub Releases API 返回 HTTP ${response.status}`);
  const releases = await response.json();
  const assets = new Map(releases.flatMap((release) => release.assets ?? []).map((asset) => [asset.browser_download_url, asset]));
  const downloads = {};
  for (const theme of catalog.themes) {
    const asset = assets.get(theme.downloadUrl);
    if (!asset || !Number.isSafeInteger(asset.download_count) || asset.download_count < 0) {
      throw new Error(`${theme.id} 缺少真实 Release 下载数据`);
    }
    const digest = String(asset.digest ?? "").toLocaleLowerCase("en-US");
    if (digest && digest !== `sha256:${theme.sha256}`) throw new Error(`${theme.id} 的 Release 摘要与目录不一致`);
    downloads[theme.id] = asset.download_count;
  }
  const metrics = normalizeSiteMetrics({
    format: "prompt-director-curated-metrics",
    version: 1,
    updatedAt: now.toISOString(),
    downloads
  }, catalog);
  await writeFile(resolve(metricsPath), `${JSON.stringify(metrics, null, 2)}\n`);
  return metrics;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [catalogPath, metricsPath] = process.argv.slice(2);
  if (!catalogPath || !metricsPath) throw new Error("用法：node tools/sync-release-metrics.mjs <catalog.json> <metrics.json>");
  const metrics = await syncReleaseMetrics({ catalogPath, metricsPath });
  process.stdout.write(`已同步 ${Object.keys(metrics.downloads).length} 个真实下载量\n`);
}
