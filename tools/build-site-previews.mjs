import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { clean, cleanPrompt, normalizeSiteCatalog, normalizeSitePreview, safeId } from "./curated-site-data.mjs";

export async function buildSitePreviews({ catalogPath, packagesPath, sitePath }) {
  const catalog = normalizeSiteCatalog(JSON.parse(await readFile(resolve(catalogPath), "utf8")));
  const packageRoot = resolve(packagesPath);
  const siteRoot = resolve(sitePath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "promptdirector-site-preview-"));
  const results = [];
  try {
    for (const theme of catalog.themes) {
      results.push(await buildThemePreview(theme, packageRoot, siteRoot, temporaryRoot));
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  return results;
}

async function buildThemePreview(theme, packageRoot, siteRoot, temporaryRoot) {
  const archivePath = resolve(packageRoot, `${safeId(theme.packageId)}.zip`);
  assertInside(packageRoot, archivePath);
  if (await sha256File(archivePath) !== theme.sha256) throw new Error(`${theme.id} 的 ZIP 校验值与目录不一致`);
  const names = await safeArchiveNames(archivePath);
  const extractRoot = join(temporaryRoot, theme.packageId);
  await mkdir(extractRoot, { recursive: true });
  await run("unzip", ["-qq", archivePath, "library.json", ...names.filter((name) => name.startsWith("images/") && !name.endsWith("/")), "-d", extractRoot]);
  await assertNoLinks(extractRoot);
  const library = JSON.parse(await readFile(join(extractRoot, "library.json"), "utf8"));
  if (library?.format !== "prompt-case-library" || library.version !== 3 || !Array.isArray(library.entries)) {
    throw new Error(`${theme.id} 不是审核后的 PromptDirector v3 包`);
  }
  if (library.entries.length !== theme.caseCount) throw new Error(`${theme.id} 的案例数量与目录不一致`);

  const previewUrl = new URL(theme.previewUrl);
  const sitePrefix = "/PromptDirector-Curated/";
  if (!previewUrl.pathname.startsWith(sitePrefix)) throw new Error(`${theme.id} 的预览地址不属于公开站点`);
  const previewRelativePath = previewUrl.pathname.slice(sitePrefix.length);
  const previewOutputPath = resolve(siteRoot, previewRelativePath);
  assertInside(siteRoot, previewOutputPath);
  const previewDirectory = dirname(previewOutputPath);
  const mediaDirectory = join(previewDirectory, "media");
  await rm(previewDirectory, { recursive: true, force: true });
  await mkdir(mediaDirectory, { recursive: true });

  const entries = [];
  for (const entry of library.entries) {
    const content = (entry.mediaAssets ?? []).find((asset) => asset?.id === entry.primaryMediaId)
      ?? (entry.mediaAssets ?? []).find((asset) => asset?.usage === "content");
    const image = content?.kind === "video"
      ? (entry.mediaAssets ?? []).find((asset) => asset?.id === content.posterAssetId)
      : content;
    if (!content || !["image", "video"].includes(content.kind) || image?.kind !== "image") {
      throw new Error(`${theme.id}/${entry.id} 缺少可公开的图片或视频封面`);
    }
    const sourceAssetPath = safeImagePath(image.assetPath);
    const sourcePath = resolve(extractRoot, sourceAssetPath);
    assertInside(extractRoot, sourcePath);
    const mediaName = `${sha256Text(clean(entry.id)).slice(0, 20)}-${basename(sourceAssetPath)}`;
    const outputMediaPath = join(mediaDirectory, mediaName);
    await copyFile(sourcePath, outputMediaPath);
    const relativeMediaUrl = new URL(`media/${encodeURIComponent(mediaName)}`, theme.previewUrl).href;
    entries.push({
      id: clean(entry.id),
      title: clean(entry.title) || "未命名案例",
      text: cleanPrompt(entry.text),
      author: caseAuthor(entry) || theme.author,
      rights: caseRights(entry, theme),
      sourceUrl: firstHttpsUrl([entry.url, ...(entry.sourcePages ?? []).map((page) => page?.url)]),
      mediaKind: content.kind,
      previewImageUrl: relativeMediaUrl,
      width: positiveInteger(image.width, `${theme.id}/${entry.id} 缺少图片宽度`),
      height: positiveInteger(image.height, `${theme.id}/${entry.id} 缺少图片高度`)
    });
  }
  const preview = normalizeSitePreview({
    format: "prompt-director-curated-preview",
    version: 1,
    catalogId: theme.id,
    packageId: theme.packageId,
    packageVersion: theme.packageVersion,
    entries
  }, theme);
  await writeFile(previewOutputPath, `${JSON.stringify(preview, null, 2)}\n`);
  return { id: theme.id, previewPath: previewOutputPath, caseCount: entries.length };
}

async function safeArchiveNames(archivePath) {
  const names = (await run("unzip", ["-Z1", archivePath])).split(/\r?\n/).filter(Boolean);
  return assertSafeArchiveNames(names, archivePath);
}

export function assertSafeArchiveNames(namesValue, archivePath = "审核包") {
  const names = Array.isArray(namesValue) ? namesValue : [];
  if (!names.includes("library.json")) throw new Error(`${archivePath} 缺少 library.json`);
  if (new Set(names).size !== names.length) throw new Error(`${archivePath} 包含重复路径`);
  for (const name of names) {
    if (name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`${archivePath} 包含不安全路径：${name}`);
    }
    if (name !== "library.json" && name !== "RIGHTS.md" && !/^(?:images|videos)\//.test(name)) {
      throw new Error(`${archivePath} 包含未审核文件：${name}`);
    }
  }
  return names;
}

async function assertNoLinks(root) {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`审核包包含符号链接：${path}`);
    if (info.isDirectory()) await assertNoLinks(path);
  }
}

function caseAuthor(entry) {
  const labels = [...(entry.metadataLabels ?? []), ...(entry.customLabels ?? [])].map(clean);
  const labeled = labels.find((label) => /^作者[:：]/.test(label));
  const values = [
    labeled?.replace(/^作者[:：]\s*/, ""),
    ...labels.flatMap((label) => [...label.matchAll(/@([A-Za-z0-9_.-]{1,64})/g)].map((match) => match[1])),
    ...String(entry.mediaAssets?.[0]?.sourceTitle ?? "").matchAll(/@([A-Za-z0-9_.-]{1,64})/g)
  ];
  for (const value of values) {
    const author = clean(value).replace(/^@/, "").split(/\s+-\s+|[|｜©]/)[0].trim();
    if (author && author.length <= 64) return `@${author}`;
  }
  return "";
}

function caseRights(entry, theme) {
  if (theme.license.includes("PromptDirector 原创")) return "PromptDirector 原创";
  const rights = (entry.metadataLabels ?? []).map(clean).find((label) => /^权利[:：]/.test(label));
  return rights ? rights.replace(/^权利[:：]\s*/, "") : "权利归原作者";
}

function firstHttpsUrl(values) {
  for (const value of values) {
    try {
      const url = new URL(clean(value));
      if (url.protocol === "https:" && !url.username && !url.password) return url.href;
    } catch {}
  }
  return "";
}

function safeImagePath(value) {
  const path = clean(value);
  if (!/^images\/[A-Za-z0-9._/-]+\.webp$/i.test(path) || path.split("/").includes("..")) throw new Error(`预览图片路径无效：${path}`);
  return path;
}

function assertInside(root, path) {
  const prefix = `${resolve(root)}${sep}`;
  if (!resolve(path).startsWith(prefix)) throw new Error(`路径超出目标目录：${path}`);
}

function positiveInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(message);
  return value;
}

async function sha256File(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`审核包不是文件：${path}`);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolvePromise(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`${command} 失败 (${code})：${Buffer.concat(stderr).toString("utf8").trim()}`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [catalogPath, packagesPath, sitePath] = process.argv.slice(2);
  if (!catalogPath || !packagesPath || !sitePath) throw new Error("用法：node tools/build-site-previews.mjs <catalog.json> <审核包目录> <site目录>");
  const result = await buildSitePreviews({ catalogPath, packagesPath, sitePath });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
