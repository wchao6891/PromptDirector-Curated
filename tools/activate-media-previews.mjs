import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSiteCatalog, normalizeSiteMediaManifest } from "./curated-site-data.mjs";

export async function activateMediaPreviews({ catalogPath, mediaManifestPath, sitePath }) {
  const catalogFile = resolve(catalogPath);
  const siteRoot = resolve(sitePath);
  const catalogValue = JSON.parse(await readFile(catalogFile, "utf8"));
  const catalog = normalizeSiteCatalog(catalogValue);
  const manifest = normalizeSiteMediaManifest(JSON.parse(await readFile(resolve(mediaManifestPath), "utf8")), catalogValue);
  const mediaPackages = new Map(manifest.packages.map((item) => [`${item.packageId}@${item.packageVersion}`, item]));
  const themes = catalog.themes.map((theme) => {
    const mediaPackage = mediaPackages.get(`${theme.packageId}@${theme.packageVersion}`);
    if (!mediaPackage) return theme;
    const digest = sha256(JSON.stringify(mediaPackage)).slice(0, 20);
    return { ...theme, previewUrl: versionedPreviewUrl(theme.previewUrl, theme.packageId, digest) };
  });
  const activatedCatalog = normalizeSiteCatalog({ ...catalog, updatedAt: new Date().toISOString(), themes });
  await writeFile(catalogFile, `${JSON.stringify(activatedCatalog, null, 2)}\n`);
  const publicManifestPath = join(siteRoot, "media", "manifest.json");
  await mkdir(dirname(publicManifestPath), { recursive: true });
  await writeFile(publicManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { catalog: activatedCatalog, publicManifestPath };
}

function versionedPreviewUrl(value, packageId, digest) {
  const url = new URL(value);
  const marker = `/${encodeURIComponent(packageId)}/`;
  const markerIndex = url.pathname.indexOf(marker);
  if (markerIndex < 0) throw new Error(`${packageId} 的预览地址无法生成摘要路径`);
  url.pathname = `${url.pathname.slice(0, markerIndex)}${marker}${digest}/preview.json`;
  url.search = "";
  url.hash = "";
  return url.href;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [catalogPath, mediaManifestPath, sitePath] = process.argv.slice(2);
  if (!catalogPath || !mediaManifestPath || !sitePath) {
    throw new Error("用法：node tools/activate-media-previews.mjs <catalog.json> <媒体清单> <site目录>");
  }
  const result = await activateMediaPreviews({ catalogPath, mediaManifestPath, sitePath });
  process.stdout.write(`${JSON.stringify({ publicManifestPath: result.publicManifestPath, previews: result.catalog.themes.map((theme) => theme.previewUrl) }, null, 2)}\n`);
}
