import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSiteCatalog } from "./curated-site-data.mjs";

export async function fetchReviewedPackages({ catalogPath, outputPath, fetchImpl = fetch }) {
  const catalog = normalizeSiteCatalog(JSON.parse(await readFile(resolve(catalogPath), "utf8")));
  const outputRoot = resolve(outputPath);
  await mkdir(outputRoot, { recursive: true });
  const results = [];
  for (const theme of catalog.themes) {
    const response = await fetchWithRetry(fetchImpl, theme.downloadUrl);
    if (!response.ok) throw new Error(`${theme.id} 下载失败（HTTP ${response.status}）`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== theme.sha256) throw new Error(`${theme.id} 下载后的 SHA-256 与目录不一致`);
    const packagePath = resolve(outputRoot, `${theme.packageId}.zip`);
    if (!packagePath.startsWith(`${outputRoot}/`)) throw new Error(`${theme.id} 的输出路径无效`);
    await writeFile(packagePath, bytes);
    results.push({ id: theme.id, packagePath, bytes: bytes.byteLength });
  }
  return results;
}

async function fetchWithRetry(fetchImpl, url) {
  const options = { cache: "no-store", redirect: "follow" };
  try {
    const response = await fetchImpl(url, options);
    if (response.status !== 408 && response.status !== 429 && response.status < 500) return response;
  } catch {}
  return fetchImpl(url, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [catalogPath, outputPath] = process.argv.slice(2);
  if (!catalogPath || !outputPath) throw new Error("用法：node tools/fetch-reviewed-packages.mjs <catalog.json> <输出目录>");
  const results = await fetchReviewedPackages({ catalogPath, outputPath });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}
