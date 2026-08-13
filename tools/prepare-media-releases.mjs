import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { assertSafeArchiveNames } from "./build-site-previews.mjs";
import { normalizeSiteCatalog, normalizeSiteMediaManifest, safeId } from "./curated-site-data.mjs";

export async function prepareMediaReleases({ catalogPath, packagesPath, outputPath, repository }) {
  const catalogValue = JSON.parse(await readFile(resolve(catalogPath), "utf8"));
  const catalog = normalizeSiteCatalog(catalogValue);
  const repositoryName = normalizeRepository(repository);
  const packageRoot = resolve(packagesPath);
  const outputRoot = resolve(outputPath);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "promptdirector-media-"));
  const packages = [];
  try {
    await mkdir(outputRoot, { recursive: true });
    for (const theme of catalog.themes.filter((item) => item.videoCount > 0)) {
      packages.push(await preparePackage({ theme, packageRoot, outputRoot, temporaryRoot, repositoryName }));
    }
    const manifest = normalizeSiteMediaManifest({
      format: "prompt-director-curated-media",
      version: 1,
      updatedAt: new Date().toISOString(),
      packages
    }, catalogValue);
    await writeFile(join(outputRoot, "media-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const item of manifest.packages) {
      await writeFile(join(outputRoot, item.packageId, "media-manifest.json"), `${JSON.stringify({ ...manifest, packages: [item] }, null, 2)}\n`);
    }
    return manifest;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function preparePackage({ theme, packageRoot, outputRoot, temporaryRoot, repositoryName }) {
  const archivePath = resolve(packageRoot, `${safeId(theme.packageId)}.zip`);
  assertInside(packageRoot, archivePath);
  if (await sha256File(archivePath) !== theme.sha256) throw new Error(`${theme.id} 的 ZIP 校验值与目录不一致`);
  const archiveNames = assertSafeArchiveNames((await run("unzip", ["-Z1", archivePath])).split(/\r?\n/).filter(Boolean), archivePath);
  const extractRoot = join(temporaryRoot, theme.packageId);
  await mkdir(extractRoot, { recursive: true });
  await run("unzip", ["-qq", archivePath, "library.json", "-d", extractRoot]);
  const library = JSON.parse(await readFile(join(extractRoot, "library.json"), "utf8"));
  if (library?.format !== "prompt-case-library" || library.version !== 3 || !Array.isArray(library.entries)) {
    throw new Error(`${theme.id} 不是审核后的 PromptDirector v3 包`);
  }
  const videos = library.entries.map((entry) => ({ entry, content: primaryContent(entry) })).filter((item) => item.content?.kind === "video");
  if (videos.length !== theme.videoCount) throw new Error(`${theme.id} 的视频数量与目录不一致`);
  const sourcePaths = videos.map(({ content }) => safeVideoPath(content.assetPath));
  for (const sourcePath of sourcePaths) {
    if (!archiveNames.includes(sourcePath)) throw new Error(`${theme.id} 缺少审核视频：${sourcePath}`);
  }
  await run("unzip", ["-qq", archivePath, ...sourcePaths, "-d", extractRoot]);
  await assertNoLinks(extractRoot);

  const releaseTag = safeId(`media-${theme.packageId}-${theme.packageVersion}`);
  const packageOutput = join(outputRoot, theme.packageId);
  await mkdir(packageOutput, { recursive: true });
  const entries = [];
  for (const { entry, content } of videos) {
    const sourcePath = resolve(extractRoot, safeVideoPath(content.assetPath));
    assertInside(extractRoot, sourcePath);
    await verifyReviewedMp4(sourcePath, `${theme.id}/${entry.id}`);
    const videoSha256 = await sha256File(sourcePath);
    const videoBytes = (await stat(sourcePath)).size;
    const assetName = `${videoSha256}.mp4`;
    const assetPath = join(packageOutput, assetName);
    if (await fileExists(assetPath)) {
      if (await sha256File(assetPath) !== videoSha256) throw new Error(`${theme.id}/${entry.id} 的媒体输出冲突`);
    } else {
      await copyFile(sourcePath, assetPath);
    }
    entries.push({
      sourceEntryId: String(entry.id ?? "").trim(),
      videoUrl: `https://github.com/${repositoryName}/releases/download/${releaseTag}/${assetName}`,
      videoSha256,
      videoBytes,
      videoMimeType: "video/mp4"
    });
  }
  return { packageId: theme.packageId, packageVersion: theme.packageVersion, releaseTag, entries };
}

function primaryContent(entry) {
  return (entry.mediaAssets ?? []).find((asset) => asset?.id === entry.primaryMediaId)
    ?? (entry.mediaAssets ?? []).find((asset) => asset?.usage === "content");
}

function safeVideoPath(value) {
  const path = String(value ?? "").trim();
  if (!/^videos\/[A-Za-z0-9._/-]+\.mp4$/i.test(path) || path.split("/").some((part) => part === "..")) {
    throw new Error(`审核视频路径无效：${path}`);
  }
  return path;
}

async function verifyReviewedMp4(path, label) {
  const output = JSON.parse(await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height", "-show_entries", "format=format_name,duration", "-of", "json", path]));
  const stream = output.streams?.[0];
  if (stream?.codec_name !== "h264" || !Number.isFinite(stream.width) || stream.width < 1 || !Number.isFinite(stream.height) || stream.height < 1) {
    throw new Error(`${label} 不是可发布的 H.264 视频`);
  }
  if (!String(output.format?.format_name ?? "").split(",").includes("mp4") || !(Number(output.format?.duration) > 0)) {
    throw new Error(`${label} 的 MP4 容器无效`);
  }
}

async function assertNoLinks(root) {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`审核包包含符号链接：${path}`);
    if (info.isDirectory()) await assertNoLinks(path);
  }
}

async function sha256File(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`文件不存在：${path}`);
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function normalizeRepository(value) {
  const repository = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub 仓库必须是 owner/repo");
  return repository;
}

function assertInside(root, path) {
  if (!resolve(path).startsWith(`${resolve(root)}${sep}`)) throw new Error(`路径超出目标目录：${basename(path)}`);
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
  const [catalogPath, packagesPath, outputPath, repository] = process.argv.slice(2);
  if (!catalogPath || !packagesPath || !outputPath || !repository) {
    throw new Error("用法：node tools/prepare-media-releases.mjs <catalog.json> <审核包目录> <输出目录> <owner/repo>");
  }
  const result = await prepareMediaReleases({ catalogPath, packagesPath, outputPath, repository });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
