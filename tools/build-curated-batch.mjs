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
  if (!title || !sourceLabel) throw new Error(`${packageId} 缺少标题或来源`);

  await assertSafeArchive(inputPath);
  const packageRoot = join(buildRoot, packageId);
  const sourceRoot = join(packageRoot, "source");
  const outputRoot = join(packageRoot, "output");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(outputRoot, "images"), { recursive: true });
  await run("unzip", ["-qq", inputPath, "library.json", "images/*", "-d", sourceRoot]);
  await assertNoLinks(sourceRoot);

  const library = JSON.parse(await readFile(join(sourceRoot, "library.json"), "utf8"));
  if (library?.format !== "prompt-case-library" || library.version !== 3 || !Array.isArray(library.entries)) {
    throw new Error(`${packageId} 不是 PromptDirector v3 分享包`);
  }

  const entries = [];
  const packagePairs = new Set();
  let inputImageBytes = 0;
  let outputImageBytes = 0;
  for (const entry of library.entries) {
    const images = (entry.mediaAssets ?? []).filter((asset) => asset?.kind === "image");
    if (images.length !== 1 || entry.mediaAssets.length !== 1) {
      throw new Error(`${entry.id || entry.title || packageId} 必须恰好包含一张图片`);
    }
    const prompt = cleanPrompt(entry.text);
    if (!prompt) throw new Error(`${entry.id || entry.title || packageId} 缺少提示词`);
    const asset = images[0];
    const assetPath = safeRelativeMediaPath(asset.assetPath);
    const inputImagePath = resolve(sourceRoot, assetPath);
    assertInside(sourceRoot, inputImagePath);
    const inputStats = await stat(inputImagePath);
    inputImageBytes += inputStats.size;
    const imageHash = await sha256File(inputImagePath);
    const promptHash = sha256Text(normalizePromptForDedupe(prompt));
    const pairHash = `${imageHash}:${promptHash}`;
    if (packagePairs.has(pairHash) || seenPairs.has(pairHash)) {
      const previous = seenPairs.get(pairHash) || packageId;
      throw new Error(`${entry.id || entry.title} 与 ${previous} 的图片和提示词完全重复`);
    }
    packagePairs.add(pairHash);
    seenPairs.set(pairHash, `${packageId}/${entry.id}`);

    const fileStem = imageHash.slice(0, 20);
    const outputAssetPath = `images/${fileStem}.webp`;
    const outputImagePath = join(outputRoot, outputAssetPath);
    await encodeWebp(inputImagePath, outputImagePath, maxEdge, quality, packageRoot);
    const outputStats = await stat(outputImagePath);
    const dimensions = await probeDimensions(outputImagePath);
    outputImageBytes += outputStats.size;

    const author = extractAuthor(entry);
    const sourceLine = [sourceLabel, author ? `@${author}` : "", "权利归原作者"].filter(Boolean).join(" · ");
    const sourceUrl = firstHttpsUrl([entry.url, ...(entry.sourcePages ?? []).map((page) => page?.url)]);
    const mediaId = clean(asset.id) || `media:${fileStem}`;
    entries.push({
      id: clean(entry.id) || `entry:${fileStem}`,
      title: author ? `${sourceLabel} · @${author}` : sourceLabel,
      text: prompt,
      savedAt: validIso(entry.savedAt) || validIso(library.exportedAt) || new Date().toISOString(),
      schemaVersion: Number.isSafeInteger(entry.schemaVersion) ? entry.schemaVersion : undefined,
      classification: {
        pathIds: ["content:prompt:image"],
        status: "confirmed",
        source: "manual"
      },
      facetAssignments: [],
      customLabels: [],
      metadataLabels: [sourceLine],
      url: sourceUrl,
      sourcePages: sourceUrl ? [{ title: author ? `${sourceLabel} · @${author}` : sourceLabel, url: sourceUrl }] : [],
      mediaAssets: [{
        id: mediaId,
        kind: "image",
        usage: "content",
        storageMode: "managed",
        sourceUrl,
        sourceTitle: author ? `${sourceLabel} · @${author}` : sourceLabel,
        capturedAt: validIso(asset.capturedAt) || validIso(entry.savedAt) || validIso(library.exportedAt),
        mimeType: "image/webp",
        width: dimensions.width,
        height: dimensions.height,
        byteSize: outputStats.size,
        reviewStatus: "verified",
        assetPath: outputAssetPath
      }],
      primaryMediaId: mediaId,
      timeNotes: []
    });
  }

  const exportedAt = new Date().toISOString();
  const taxonomy = sanitizeTaxonomy(library.taxonomy);
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
    `${title}整理自公开网络分享，图片与提示词权利归原作者；如有侵权请通过 PromptDirector Curated 权利反馈申请下架。\n`
  );
  await normalizeTimestamps(outputRoot);
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });
  await writePromptDirectorZip(outputPath, outputRoot, [
    "library.json",
    ...entries.map((entry) => entry.mediaAssets[0].assetPath),
    "RIGHTS.md"
  ]);

  if (coverPath) {
    const coverSource = join(outputRoot, entries[0].mediaAssets[0].assetPath);
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
    caseCount: entries.length,
    imageCount: entries.length,
    inputImageBytes,
    outputImageBytes,
    archiveBytes: outputStats.size,
    sha256: await sha256File(outputPath),
    maxWidth: Math.max(...entries.map((entry) => entry.mediaAssets[0].width)),
    maxHeight: Math.max(...entries.map((entry) => entry.mediaAssets[0].height))
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
  }
}

async function assertNoLinks(root) {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`分享包包含符号链接：${path}`);
    if (info.isDirectory()) await assertNoLinks(path);
  }
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

function normalizePromptForDedupe(value) {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function sanitizeTaxonomy(value = {}) {
  const imagePrompt = (value.nodes ?? []).find((node) => node?.id === "content:prompt:image");
  if (!imagePrompt) throw new Error("分享包缺少图片提示词分类");
  return {
    version: Number.isSafeInteger(value.version) ? value.version : 1,
    revision: Number.isSafeInteger(value.revision) ? value.revision : 1,
    nodes: [structuredClone(imagePrompt)]
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

function safeRelativeMediaPath(value) {
  const path = clean(value);
  if (!/^images\/[A-Za-z0-9._/-]+\.(?:png|jpe?g|webp)$/i.test(path) || path.split("/").includes("..")) {
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
