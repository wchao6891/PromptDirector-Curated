import { createHash } from "node:crypto";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { writePromptDirectorZip } from "./curated-zip.mjs";

const configPath = process.argv[2];
if (!configPath || process.argv.length !== 3) {
  throw new Error("用法：node tools/build-curated-batch.mjs <build-config.json>");
}

const config = JSON.parse(await readFile(resolve(configPath), "utf8"));
const maxEdge = positiveInteger(config.maxEdge, "maxEdge");
const quality = boundedInteger(config.quality, 1, 100, "quality");
if (!Array.isArray(config.packages) || !config.packages.length) throw new Error("缺少 packages 配置");

const buildRoot = await mkdtemp(join(tmpdir(), "promptdirector-curated-"));
const seenPairs = new Map();
const reports = [];

try {
  for (const packageConfig of config.packages) {
    reports.push(await buildPackage(packageConfig));
  }
  const reportPath = resolve(config.reportPath);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify({ maxEdge, quality, packages: reports }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ reportPath, packages: reports }, null, 2)}\n`);
} finally {
  await rm(buildRoot, { recursive: true, force: true });
}

async function buildPackage(packageConfig) {
  const packageId = safeId(packageConfig.id);
  const title = clean(packageConfig.title);
  const sourceLabel = clean(packageConfig.sourceLabel);
  const inputPath = resolve(packageConfig.input);
  const outputPath = resolve(packageConfig.output);
  const coverPath = packageConfig.cover ? resolve(packageConfig.cover) : "";
  const coverEntryId = clean(packageConfig.coverEntryId);
  if (!title || !sourceLabel) throw new Error(`${packageId} 缺少标题或来源`);

  const packageRoot = join(buildRoot, packageId);
  const sourceRoot = join(packageRoot, "source");
  const outputRoot = join(packageRoot, "output");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(outputRoot, "images"), { recursive: true });
  await mkdir(join(outputRoot, "videos"), { recursive: true });
  const archiveNames = await assertSafeArchive(inputPath);
  const mediaNames = archiveNames.filter((name) => /^(?:images|videos)\/.+/.test(name) && !name.endsWith("/"));
  await run("unzip", ["-qq", inputPath, "library.json", ...mediaNames, "-d", sourceRoot]);
  await assertNoLinks(sourceRoot);

  const library = JSON.parse(await readFile(join(sourceRoot, "library.json"), "utf8"));
  if (library?.format !== "prompt-case-library" || library.version !== 3 || !Array.isArray(library.entries)) {
    throw new Error(`${packageId} 不是 PromptDirector v3 分享包`);
  }

  const entries = [];
  const packagePairs = new Set();
  let inputImageBytes = 0;
  let outputImageBytes = 0;
  let inputVideoBytes = 0;
  let outputVideoBytes = 0;
  for (const entry of library.entries) {
    const sourceAssets = Array.isArray(entry.mediaAssets) ? entry.mediaAssets : [];
    const contentAssets = sourceAssets.filter((asset) => asset?.usage === "content" && ["image", "video"].includes(asset?.kind));
    if (contentAssets.length !== 1) throw new Error(`${entry.id || entry.title || packageId} 必须恰好包含一项图片或视频内容`);
    const primaryAsset = contentAssets[0];
    if (clean(entry.primaryMediaId) && clean(entry.primaryMediaId) !== clean(primaryAsset.id)) {
      throw new Error(`${entry.id || entry.title || packageId} 的主媒体关系无效`);
    }
    const posterAsset = primaryAsset.kind === "video"
      ? sourceAssets.find((asset) => clean(asset?.id) === clean(primaryAsset.posterAssetId))
      : null;
    if (primaryAsset.kind === "image" && sourceAssets.length !== 1) {
      throw new Error(`${entry.id || entry.title || packageId} 的图片案例包含未审核的额外媒体`);
    }
    if (primaryAsset.kind === "video" && (
      sourceAssets.length !== 2
      || posterAsset?.kind !== "image"
      || posterAsset?.usage !== "poster"
    )) {
      throw new Error(`${entry.id || entry.title || packageId} 的视频必须恰好包含一个封面`);
    }
    const prompt = cleanPrompt(entry.text);
    if (!prompt) throw new Error(`${entry.id || entry.title || packageId} 缺少提示词`);
    const primaryPath = safeRelativeMediaPath(primaryAsset.assetPath, primaryAsset.kind);
    const inputPrimaryPath = resolve(sourceRoot, primaryPath);
    assertInside(sourceRoot, inputPrimaryPath);
    const inputPrimaryStats = await stat(inputPrimaryPath);
    if (primaryAsset.kind === "image") inputImageBytes += inputPrimaryStats.size;
    else inputVideoBytes += inputPrimaryStats.size;
    const mediaHash = await sha256File(inputPrimaryPath);
    const promptHash = sha256Text(normalizePromptForDedupe(prompt));
    const pairHash = `${mediaHash}:${promptHash}`;
    if (packagePairs.has(pairHash) || seenPairs.has(pairHash)) {
      const previous = seenPairs.get(pairHash) || packageId;
      throw new Error(`${entry.id || entry.title} 与 ${previous} 的媒体和提示词完全重复`);
    }
    packagePairs.add(pairHash);
    seenPairs.set(pairHash, `${packageId}/${entry.id}`);

    const fileStem = mediaHash.slice(0, 20);
    const author = extractAuthor(entry);
    const sourceTitle = author ? `${sourceLabel} · @${author}` : sourceLabel;
    const sourceUrl = firstHttpsUrl([entry.url, ...(entry.sourcePages ?? []).map((page) => page?.url)]);
    const mediaId = clean(primaryAsset.id) || `media:${fileStem}`;
    const processedPrimary = primaryAsset.kind === "image"
      ? await processImageAsset(primaryAsset, {
        inputPath: inputPrimaryPath,
        outputRoot,
        packageRoot,
        fileStem,
        mediaId,
        sourceUrl,
        sourceTitle
      })
      : await processVideoAsset(primaryAsset, {
        inputPath: inputPrimaryPath,
        outputRoot,
        fileStem,
        mediaId,
        sourceUrl,
        sourceTitle
      });
    if (processedPrimary.kind === "image") outputImageBytes += processedPrimary.byteSize;
    else outputVideoBytes += processedPrimary.byteSize;

    const processedAssets = [processedPrimary];
    if (posterAsset) {
      const posterPath = safeRelativeMediaPath(posterAsset.assetPath, "image");
      const inputPosterPath = resolve(sourceRoot, posterPath);
      assertInside(sourceRoot, inputPosterPath);
      const inputPosterStats = await stat(inputPosterPath);
      inputImageBytes += inputPosterStats.size;
      const posterHash = await sha256File(inputPosterPath);
      const posterId = clean(posterAsset.id) || `poster:${fileStem}`;
      const processedPoster = await processImageAsset(posterAsset, {
        inputPath: inputPosterPath,
        outputRoot,
        packageRoot,
        fileStem: `${posterHash.slice(0, 20)}-poster`,
        mediaId: posterId,
        sourceUrl,
        sourceTitle,
        usage: "poster",
        derivedFromAssetId: mediaId
      });
      outputImageBytes += processedPoster.byteSize;
      processedPrimary.posterAssetId = posterId;
      processedAssets.push(processedPoster);
    }

    const entryTitle = clean(entry.title) || sourceTitle;
    entries.push({
      id: clean(entry.id) || `entry:${fileStem}`,
      title: entryTitle,
      text: prompt,
      savedAt: validIso(entry.savedAt) || validIso(library.exportedAt) || new Date().toISOString(),
      schemaVersion: Number.isSafeInteger(entry.schemaVersion) ? entry.schemaVersion : undefined,
      classification: {
        pathIds: [primaryAsset.kind === "video" ? "content:prompt:video" : "content:prompt:image"],
        status: "confirmed",
        source: "manual"
      },
      facetAssignments: [],
      customLabels: [],
      metadataLabels: sourceMetadataLabels(entry, sourceLabel, author, primaryAsset.kind),
      url: sourceUrl,
      sourcePages: sourceUrl ? [{ title: clean(entry.sourcePages?.[0]?.title) || sourceTitle, url: sourceUrl }] : [],
      mediaAssets: processedAssets,
      primaryMediaId: mediaId,
      timeNotes: []
    });
  }

  const exportedAt = validIso(packageConfig.publishedAt) || validIso(library.exportedAt) || new Date().toISOString();
  const taxonomy = sanitizeTaxonomy(library.taxonomy, new Set(entries.flatMap((entry) => entry.classification.pathIds)));
  const curatedLibrary = {
    format: "prompt-case-library",
    version: 3,
    exportedAt,
    entries,
    taxonomy,
    facetCatalog: { version: 2, revision: 1, facets: [], nodes: [] },
    classificationRules: [],
    compoundCases: [],
    organizerState: {
      version: 4,
      collections: [{
        id: `collection:${packageId}`,
        name: title,
        order: 0,
        entryIds: entries.map((entry) => entry.id),
        projectMethods: {}
      }]
    },
    settings: { libraryTitle: title, outputPath: basename(outputPath) }
  };
  await writeFile(join(outputRoot, "library.json"), `${JSON.stringify(curatedLibrary, null, 2)}\n`);
  await writeFile(
    join(outputRoot, "RIGHTS.md"),
    `${title}整理自公开网络分享，图片、视频与提示词权利归原作者或其他权利人；收录与署名不代表已获得商业授权。如有权利争议，请通过 PromptDirector Curated 权利反馈申请核实与下架。\n`
  );
  await normalizeTimestamps(outputRoot);
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  await writePromptDirectorZip(outputPath, outputRoot, [
    "library.json",
    ...new Set(entries.flatMap((entry) => entry.mediaAssets.map((asset) => asset.assetPath))),
    "RIGHTS.md"
  ]);

  if (coverPath) {
    const coverEntry = coverEntryId ? entries.find((entry) => entry.id === coverEntryId) : entries[0];
    if (!coverEntry) throw new Error(`${packageId} 的封面案例不存在：${coverEntryId}`);
    const coverAsset = coverEntry.mediaAssets.find((asset) => asset.kind === "image");
    if (!coverAsset) throw new Error(`${packageId} 缺少可用封面`);
    const coverSource = join(outputRoot, coverAsset.assetPath);
    await mkdir(dirname(coverPath), { recursive: true });
    await cp(coverSource, coverPath);
  }

  const outputStats = await stat(outputPath);
  return {
    id: packageId,
    title,
    sourceLabel,
    inputPath,
    outputPath,
    coverPath,
    coverEntryId: coverEntryId || entries[0]?.id || "",
    caseCount: entries.length,
    imageCount: entries.flatMap((entry) => entry.mediaAssets).filter((asset) => asset.kind === "image").length,
    videoCount: entries.flatMap((entry) => entry.mediaAssets).filter((asset) => asset.kind === "video").length,
    inputImageBytes,
    outputImageBytes,
    inputVideoBytes,
    outputVideoBytes,
    archiveBytes: outputStats.size,
    sha256: await sha256File(outputPath),
    maxWidth: Math.max(...entries.flatMap((entry) => entry.mediaAssets).map((asset) => asset.width)),
    maxHeight: Math.max(...entries.flatMap((entry) => entry.mediaAssets).map((asset) => asset.height))
  };
}

async function assertSafeArchive(inputPath) {
  const listing = await run("unzip", ["-Z1", inputPath]);
  const names = listing.split(/\r?\n/).filter(Boolean);
  if (!names.includes("library.json")) throw new Error(`${inputPath} 缺少 library.json`);
  for (const name of names) {
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\\")) {
      throw new Error(`${inputPath} 包含不安全路径：${name}`);
    }
    if (name !== "library.json" && name !== "RIGHTS.md" && !/^(?:images|videos)\//.test(name)) {
      throw new Error(`${inputPath} 包含不属于分享包的文件：${name}`);
    }
  }
  return names;
}

async function assertNoLinks(root) {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`分享包包含符号链接：${path}`);
    if (info.isDirectory()) await assertNoLinks(path);
  }
}

async function processImageAsset(asset, options) {
  const {
    inputPath,
    outputRoot,
    packageRoot,
    fileStem,
    mediaId,
    sourceUrl,
    sourceTitle,
    usage = "content",
    derivedFromAssetId = ""
  } = options;
  const outputAssetPath = `images/${fileStem}.webp`;
  const outputPath = join(outputRoot, outputAssetPath);
  await encodeWebp(inputPath, outputPath, maxEdge, quality, packageRoot);
  const outputStats = await stat(outputPath);
  const dimensions = await probeDimensions(outputPath);
  return {
    id: mediaId,
    kind: "image",
    usage,
    storageMode: "managed",
    sourceUrl: firstHttpsUrl([asset.sourceUrl, sourceUrl]),
    sourceTitle: clean(asset.sourceTitle) || sourceTitle,
    capturedAt: validIso(asset.capturedAt),
    mimeType: "image/webp",
    width: dimensions.width,
    height: dimensions.height,
    byteSize: outputStats.size,
    reviewStatus: "verified",
    ...(derivedFromAssetId ? { derivedFromAssetId } : {}),
    assetPath: outputAssetPath
  };
}

async function processVideoAsset(asset, options) {
  const { inputPath, outputRoot, fileStem, mediaId, sourceUrl, sourceTitle } = options;
  const outputAssetPath = `videos/${fileStem}.mp4`;
  const outputPath = join(outputRoot, outputAssetPath);
  const video = await probeVideo(inputPath);
  await cp(inputPath, outputPath);
  const outputStats = await stat(outputPath);
  return {
    id: mediaId,
    kind: "video",
    usage: "content",
    storageMode: "managed",
    sourceUrl: firstHttpsUrl([asset.sourceUrl, sourceUrl]),
    sourceTitle: clean(asset.sourceTitle) || sourceTitle,
    capturedAt: validIso(asset.capturedAt),
    mimeType: "video/mp4",
    width: video.width,
    height: video.height,
    durationMs: video.durationMs,
    byteSize: outputStats.size,
    playbackCapability: "native",
    reviewStatus: "verified",
    assetPath: outputAssetPath
  };
}

async function encodeWebp(inputPath, outputPath, maxEdgeValue, qualityValue, packageRoot) {
  const { width, height } = await probeDimensions(inputPath);
  const resizeArgs = width && height && Math.max(width, height) > maxEdgeValue
    ? width >= height
      ? ["-resize", String(maxEdgeValue), "0"]
      : ["-resize", "0", String(maxEdgeValue)]
    : [];
  let encoderInput = inputPath;
  if (extname(inputPath).toLocaleLowerCase() === ".webp") {
    encoderInput = join(packageRoot, `${basename(inputPath)}.png`);
    await run("dwebp", [inputPath, "-o", encoderInput]);
  }
  await run("cwebp", ["-quiet", "-mt", "-m", "6", "-metadata", "none", "-q", String(qualityValue), ...resizeArgs, encoderInput, "-o", outputPath]);
}

async function probeDimensions(path) {
  const output = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path]);
  const stream = JSON.parse(output)?.streams?.[0];
  return {
    width: positiveInteger(stream?.width, "输出图片宽度"),
    height: positiveInteger(stream?.height, "输出图片高度")
  };
}

async function probeVideo(path) {
  const output = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name:format=duration,format_name",
    "-of", "json",
    path
  ]);
  const result = JSON.parse(output);
  const stream = result?.streams?.[0];
  const durationSeconds = Number(result?.format?.duration);
  if (!stream || stream.codec_name !== "h264" || !String(result?.format?.format_name ?? "").split(",").includes("mp4")) {
    throw new Error(`视频必须是可在浏览器中播放的 H.264 MP4：${path}`);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`视频时长无效：${path}`);
  return {
    width: positiveInteger(stream.width, "视频宽度"),
    height: positiveInteger(stream.height, "视频高度"),
    durationMs: Math.round(durationSeconds * 1000)
  };
}

function extractAuthor(entry) {
  const labels = [...(entry.metadataLabels ?? []), ...(entry.customLabels ?? [])].map(clean);
  const labeled = labels.find((label) => /^作者[:：]/.test(label));
  const candidates = [
    labeled?.replace(/^作者[:：]\s*/, ""),
    ...labels.flatMap((label) => [...label.matchAll(/@([A-Za-z0-9_.-]{1,64})/g)].map((match) => match[1])),
    ...String(entry.title ?? "").matchAll(/@([A-Za-z0-9_.-]{1,64})/g),
    ...String(entry.text ?? "").matchAll(/(?:^|\n)作者[:：]\s*([^\n]{1,80})/g)
  ];
  for (const candidateValue of candidates) {
    const candidate = clean(Array.isArray(candidateValue) ? candidateValue[1] : candidateValue)
      .replace(/^@/, "")
      .split(/\s+-\s+|[|｜©]|温馨提示/)[0]
      .replace(/[-—]+$/, "")
      .trim();
    if (candidate && candidate.length <= 64) return candidate;
  }
  return "";
}

function cleanPrompt(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split(/\n\s*\n作者[:：]/)[0]
    .trim();
}

function sourceMetadataLabels(entry, sourceLabel, author, mediaKind) {
  const allowedPrefixes = ["作者：", "作者账号：", "来源编号：", "时长：", "Remix：", "元素："];
  const retained = (entry.metadataLabels ?? [])
    .map((label) => clean(label))
    .filter((label) => allowedPrefixes.some((prefix) => label.startsWith(prefix)));
  const labels = [
    `来源：${sourceLabel}`,
    author && !retained.some((label) => label.startsWith("作者：")) ? `作者：${author}` : "",
    `媒体：${mediaKind === "video" ? "视频" : "图片"}`,
    ...retained,
    "权利：归原作者或其他权利人"
  ].filter(Boolean);
  return [...new Set(labels)];
}

function normalizePromptForDedupe(value) {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function sanitizeTaxonomy(value = {}, requiredIds = new Set()) {
  const nodes = [...requiredIds].map((id) => (value.nodes ?? []).find((node) => node?.id === id));
  if (nodes.some((node) => !node)) throw new Error("分享包缺少所需的图片或视频提示词分类");
  return {
    version: Number.isSafeInteger(value.version) ? value.version : 1,
    revision: Number.isSafeInteger(value.revision) ? value.revision : 1,
    nodes: nodes.map((node) => structuredClone(node))
  };
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

function safeRelativeMediaPath(value, kind) {
  const path = clean(value);
  const valid = kind === "video"
    ? /^videos\/[A-Za-z0-9._/-]+\.mp4$/i.test(path)
    : /^images\/[A-Za-z0-9._/-]+\.(?:png|jpe?g|webp)$/i.test(path);
  if (!valid || path.split("/").includes("..")) {
    throw new Error(`媒体路径无效：${path}`);
  }
  return path;
}

function assertInside(root, path) {
  const normalizedRoot = `${resolve(root)}${sep}`;
  if (!resolve(path).startsWith(normalizedRoot)) throw new Error(`路径超出构建目录：${path}`);
}

function safeId(value) {
  const id = clean(value);
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new Error(`包编号无效：${id}`);
  return id;
}

function clean(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

function validIso(value) {
  const text = clean(value);
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : "";
}

function positiveInteger(value, label, required = true) {
  const number = Number(value);
  if (Number.isSafeInteger(number) && number > 0) return number;
  if (!required) return 0;
  throw new Error(`${label} 必须是正整数`);
}

function boundedInteger(value, min, max, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} 超出范围`);
  return number;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function normalizeTimestamps(root) {
  const timestamp = new Date("1980-01-01T00:00:00.000Z");
  const paths = [];
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isDirectory()) await visit(path);
      paths.push(path);
    }
  }
  await visit(root);
  for (const path of paths) await utimes(path, timestamp, timestamp);
  await utimes(root, timestamp, timestamp);
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      if (code === 0) return resolvePromise(output);
      reject(new Error(`${command} 失败 (${code})：${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}
