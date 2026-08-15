import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_POLICY_PATH = join(ROOT, "submission-policy.json");
const SUBMISSION_FORMAT = "prompt-director-curated-submission";
const PART_FORMAT = "prompt-director-curated-submission-part";
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;

export async function preflightSubmission(inputFiles, options = {}) {
  const policy = options.policy ?? JSON.parse(await readFile(options.policyPath ?? DEFAULT_POLICY_PATH, "utf8"));
  if (!inputFiles.length || inputFiles.length > policy.maxTransportFiles) throw new Error("投稿文件数量超过安全上限");
  const files = await Promise.all(inputFiles.map(readInputFile));
  if (files.some((file) => file.bytes.byteLength > policy.maxTransportFileBytes)) {
    throw new Error("单个投稿文件超过上传上限");
  }
  if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > policy.maxTransportFileBytes * policy.maxTransportFiles) {
    throw new Error("投稿文件总大小超过安全上限");
  }

  const archive = await reconstructSubmissionArchive(files, policy);
  const transport = readStoredZip(archive.bytes, {
    maxBytes: policy.maxSubmissionBytes,
    maxFiles: 2,
    maxFileBytes: policy.maxSubmissionBytes
  });
  assertExactNames(transport, ["submission.json", "payload.zip"]);
  const manifest = parseJson(transport.get("submission.json"), "投稿清单");
  assertSubmissionManifest(manifest);
  const payload = transport.get("payload.zip");
  const submissionId = sha256(payload);
  if (manifest.submissionId !== submissionId || manifest.payloadBytes !== payload.byteLength) {
    throw new Error("投稿清单与实际内容不一致");
  }
  if (archive.submissionId && archive.submissionId !== submissionId) throw new Error("分卷与投稿内容身份不一致");

  const review = await inspectPayload(payload, policy, options);
  if (manifest.caseCount !== review.caseCount || manifest.mediaCount !== review.mediaCount) {
    throw new Error("投稿清单中的案例或媒体数量不一致");
  }
  return {
    ok: true,
    submissionId,
    caseCount: review.caseCount,
    mediaCount: review.mediaCount,
    partCount: files.length,
    payload
  };
}

export async function reconstructSubmissionArchive(files, policy) {
  const firstZip = readStoredZip(files[0].bytes, {
    maxBytes: policy.maxTransportFileBytes,
    maxFiles: 2,
    maxFileBytes: policy.maxSubmissionBytes
  });
  if (firstZip.has("submission.json")) {
    if (files.length !== 1) throw new Error("完整投稿包不能与分卷混合上传");
    return { bytes: files[0].bytes, submissionId: "" };
  }

  const parts = files.map((file) => {
    const zip = readStoredZip(file.bytes, {
      maxBytes: policy.maxTransportFileBytes,
      maxFiles: 2,
      maxFileBytes: policy.maxTransportFileBytes
    });
    assertExactNames(zip, ["part.json", "payload.bin"]);
    const manifest = parseJson(zip.get("part.json"), "分卷清单");
    assertPartManifest(manifest);
    const payload = zip.get("payload.bin");
    if (manifest.payloadBytes !== payload.byteLength || manifest.payloadSha256 !== sha256(payload)) {
      throw new Error("投稿分卷已损坏或被修改");
    }
    return { manifest, payload };
  });

  const identity = parts[0].manifest;
  const seen = new Set();
  for (const part of parts) {
    const current = part.manifest;
    for (const key of ["submissionId", "archiveSha256", "archiveBytes", "partCount"]) {
      if (current[key] !== identity[key]) throw new Error("上传的分卷不属于同一个投稿包");
    }
    if (seen.has(current.partIndex)) throw new Error("上传了重复分卷");
    seen.add(current.partIndex);
  }
  if (identity.partCount !== parts.length || [...seen].some((index) => index < 1 || index > identity.partCount)) {
    throw new Error("投稿分卷不完整");
  }
  parts.sort((a, b) => a.manifest.partIndex - b.manifest.partIndex);
  const bytes = concat(parts.map((part) => part.payload));
  if (bytes.byteLength !== identity.archiveBytes || bytes.byteLength > policy.maxSubmissionBytes) {
    throw new Error("重组后的投稿包大小无效");
  }
  if (sha256(bytes) !== identity.archiveSha256) throw new Error("重组后的投稿包校验失败");
  return { bytes, submissionId: identity.submissionId };
}

export function readStoredZip(bytesValue, limits) {
  const bytes = asBytes(bytesValue);
  if (bytes.byteLength < 22 || bytes.byteLength > limits.maxBytes) throw new Error("ZIP 大小无效");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndRecord(view);
  if (endOffset < 0) throw new Error("这不是有效的 ZIP");
  const disk = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const diskCount = view.getUint16(endOffset + 8, true);
  const fileCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);
  if (disk || directoryDisk || diskCount !== fileCount || fileCount > limits.maxFiles || commentLength !== 0 ||
      endOffset + 22 + commentLength !== bytes.byteLength || directoryOffset + directorySize !== endOffset) {
    throw new Error("不支持分卷、ZIP64 或异常目录结构");
  }

  const files = new Map();
  const ranges = [];
  let declaredBytes = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < fileCount; index += 1) {
    if (cursor + 46 > endOffset || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP 目录损坏");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const entryCommentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (flags !== UTF8_FLAG || method !== STORE_METHOD || compressedSize !== size || extraLength || entryCommentLength) {
      throw new Error("投稿 ZIP 必须由 PromptDirector 生成且不可加密");
    }
    if (size > limits.maxFileBytes) throw new Error("ZIP 内单个文件超过安全上限");
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + entryCommentLength > endOffset) throw new Error("ZIP 目录损坏");
    if (!(flags & UTF8_FLAG) && bytes.subarray(nameStart, nameEnd).some((byte) => byte > 0x7f)) {
      throw new Error("ZIP 文件名编码不安全");
    }
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(nameStart, nameEnd));
    assertSafePath(name);
    if (files.has(name)) throw new Error("ZIP 内存在重复文件路径");
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ZIP 本地目录损坏");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localChecksum = view.getUint32(localOffset + 14, true);
    const localSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(localNameStart, localNameEnd));
    const dataOffset = localNameEnd + localExtraLength;
    const dataEnd = dataOffset + size;
    if (localExtraLength || localFlags !== flags || localMethod !== method || localChecksum !== checksum || localSize !== size ||
        localName !== name || dataEnd > directoryOffset) throw new Error("ZIP 文件记录不一致");
    const data = bytes.slice(dataOffset, dataEnd);
    if (crc32(data) !== checksum) throw new Error("ZIP 文件校验失败");
    declaredBytes += data.byteLength;
    if (declaredBytes > limits.maxBytes) throw new Error("ZIP 解压内容超过安全上限");
    files.set(name, data);
    ranges.push({ start: localOffset, end: dataEnd });
    cursor = nameEnd + extraLength + entryCommentLength;
  }
  if (cursor !== endOffset) throw new Error("ZIP 目录长度异常");
  ranges.sort((left, right) => left.start - right.start);
  if (!ranges.length || ranges[0].start !== 0 || ranges.at(-1).end !== directoryOffset ||
      ranges.some((range, index) => index > 0 && ranges[index - 1].end !== range.start)) {
    throw new Error("ZIP 文件区域存在重叠或隐藏内容");
  }
  return files;
}

async function inspectPayload(payload, policy, options) {
  const zip = readStoredZip(payload, {
    maxBytes: policy.maxSubmissionBytes,
    maxFiles: policy.maxFileCount,
    maxFileBytes: Math.max(policy.maxVideoBytes, policy.maxLibraryJsonBytes)
  });
  if (!zip.has("library.json")) throw new Error("投稿内容缺少 library.json");
  for (const name of zip.keys()) {
    if (name !== "library.json" && !/^(?:images|videos)\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error("投稿内容包含不允许的文件");
    }
  }
  if (zip.get("library.json").byteLength > policy.maxLibraryJsonBytes) throw new Error("案例清单超过安全上限");
  const library = parseJson(zip.get("library.json"), "案例清单");
  if (library?.format !== "prompt-case-library" || library.version !== 3 || !Array.isArray(library.entries)) {
    throw new Error("投稿内容不是 PromptDirector v3 案例包");
  }
  if (!library.entries.length || library.entries.length > policy.maxEntries) throw new Error("投稿案例数量无效");
  assertPublicLibraryShape(library);

  const usedPaths = new Set();
  let mediaCount = 0;
  const probes = [];
  for (const entry of library.entries) {
    const prompt = String(entry?.text ?? "").trim();
    if (!prompt) throw new Error("投稿案例缺少提示词");
    assertOptionalHttps(entry?.url);
    for (const page of entry?.sourcePages ?? []) assertOptionalHttps(page?.url);
    const assets = Array.isArray(entry?.mediaAssets) ? entry.mediaAssets : [];
    const content = assets.filter((asset) => asset?.usage === "content" && ["image", "video"].includes(asset?.kind));
    if (content.length !== 1 || assets.length !== (content[0].kind === "video" ? 2 : 1)) throw new Error("案例媒体关系无效");
    if (content[0].kind === "video") {
      const poster = assets.find((asset) => asset?.id === content[0].posterAssetId);
      if (poster?.kind !== "image" || poster?.usage !== "poster") throw new Error("视频案例缺少唯一封面");
    }
    for (const asset of assets) {
      if (asset?.storageMode !== "managed") throw new Error("投稿媒体必须是已保存的本地文件");
      const path = String(asset?.assetPath ?? "");
      assertSafeMediaPath(path, asset.kind);
      if (usedPaths.has(path) || !zip.has(path)) throw new Error("投稿媒体路径缺失或重复");
      usedPaths.add(path);
      const bytes = zip.get(path);
      const limit = asset.kind === "video" ? policy.maxVideoBytes : policy.maxImageBytes;
      if (!bytes.byteLength || bytes.byteLength > limit) throw new Error("投稿媒体大小超过安全上限");
      assertMediaSignature(bytes, asset.kind, path);
      probes.push({ bytes, kind: asset.kind, path });
      mediaCount += 1;
    }
  }
  const unreferenced = [...zip.keys()].filter((name) => name !== "library.json" && !usedPaths.has(name));
  if (unreferenced.length) throw new Error("投稿包包含未被案例引用的媒体");
  if (!options.skipMediaProbe) await probeMedia(probes, policy);
  return { caseCount: library.entries.length, mediaCount };
}

async function probeMedia(items, policy) {
  const root = await mkdtemp(join(tmpdir(), "promptdirector-submission-"));
  try {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const extension = item.kind === "video" ? ".mp4" : extensionFor(item.path);
      const path = join(root, `${index}${extension}`);
      await writeFile(path, item.bytes);
      const data = JSON.parse(await run("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height:format=format_name",
        "-of", "json", path
      ]));
      const stream = data.streams?.[0];
      if (!stream?.width || !stream?.height || stream.width * stream.height > policy.maxImagePixels) {
        throw new Error("媒体尺寸无效或超过安全上限");
      }
      if (item.kind === "video" && (stream.codec_name !== "h264" || !String(data.format?.format_name ?? "").split(",").includes("mov"))) {
        throw new Error("视频必须是 H.264 MP4");
      }
      if (item.kind === "image" && !["png", "mjpeg", "webp"].includes(stream.codec_name)) {
        throw new Error("图片格式不受支持");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readInputFile(value) {
  if (value instanceof Uint8Array) return { name: "submission.zip", bytes: value };
  if (value?.bytes) return { name: String(value.name ?? "submission.zip"), bytes: asBytes(value.bytes) };
  const path = resolve(String(value));
  return { name: basename(path), bytes: new Uint8Array(await readFile(path)) };
}

export function extractOfficialAttachmentUrls(body) {
  const urls = String(body ?? "").match(/https:\/\/[^\s)\]}>"']+/g) ?? [];
  return [...new Set(urls.filter(isOfficialAttachmentUrl))];
}

export function isOfficialAttachmentUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.hostname === "github.com") return /^\/user-attachments\/(?:assets|files)\//.test(url.pathname);
    return [
      "user-attachments.githubusercontent.com",
      "objects.githubusercontent.com",
      "github-releases.githubusercontent.com"
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

async function downloadAttachment(url, policy) {
  if (!isOfficialAttachmentUrl(url)) throw new Error("附件地址不是 GitHub 官方地址");
  const response = await fetch(url, { credentials: "omit", redirect: "follow" });
  if (!response.ok) throw new Error(`GitHub 附件下载失败（${response.status}）`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > policy.maxTransportFileBytes) throw new Error("附件超过上传上限");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > policy.maxTransportFileBytes) throw new Error("附件超过上传上限");
  return { name: basename(new URL(url).pathname) || "submission.zip", bytes };
}

function assertPublicLibraryShape(library) {
  assertAllowedKeys(library, [
    "format", "version", "schemaVersion", "exportedAt", "settings", "taxonomy", "facetCatalog",
    "classificationRules", "organizerState", "compoundCases", "entries"
  ], "案例包");
  if ((library.classificationRules ?? []).length || (library.compoundCases ?? []).length ||
      (library.organizerState?.collections ?? []).length || (library.facetCatalog?.facets ?? []).length ||
      (library.facetCatalog?.nodes ?? []).length) {
    throw new Error("投稿包包含不需要公开的分类、组合或项目数据");
  }
  for (const entry of library.entries) {
    assertAllowedKeys(entry, [
      "id", "title", "text", "savedAt", "schemaVersion", "classification", "facetAssignments",
      "customLabels", "metadataLabels", "url", "sourcePages", "mediaAssets", "primaryMediaId",
      "timeNotes", "mediaPrompts", "visualSetAnalyses", "videoAnalyses"
    ], "案例");
    for (const key of ["facetAssignments", "customLabels", "timeNotes", "mediaPrompts", "visualSetAnalyses", "videoAnalyses"]) {
      if (!Array.isArray(entry[key]) || entry[key].length) throw new Error("投稿案例包含不需要公开的个人数据");
    }
    if (!(entry.metadataLabels ?? []).every((label) => /^(?:作者|权利)[:：]/u.test(String(label)))) {
      throw new Error("投稿案例包含非公开元数据");
    }
    for (const page of entry.sourcePages ?? []) assertAllowedKeys(page, ["title", "url"], "来源");
    for (const asset of entry.mediaAssets ?? []) {
      assertAllowedKeys(asset, [
        "id", "kind", "usage", "storageMode", "sourceUrl", "sourceTitle", "capturedAt", "mimeType",
        "width", "height", "durationMs", "byteSize", "posterAssetId", "derivedFromAssetId",
        "reviewStatus", "playbackCapability", "assetPath"
      ], "媒体");
    }
  }
}

function assertAllowedKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}结构无效`);
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new Error(`${label}包含未公开字段`);
}

function assertSubmissionManifest(value) {
  if (value?.format !== SUBMISSION_FORMAT || value.version !== 1 || !isSha256(value.submissionId) ||
      !positiveInteger(value.payloadBytes) || !positiveInteger(value.caseCount) || !positiveInteger(value.mediaCount)) {
    throw new Error("投稿清单格式无效");
  }
}

function assertPartManifest(value) {
  if (value?.format !== PART_FORMAT || value.version !== 1 || !isSha256(value.submissionId) ||
      !isSha256(value.archiveSha256) || !isSha256(value.payloadSha256) ||
      !positiveInteger(value.archiveBytes) || !positiveInteger(value.partIndex) ||
      !positiveInteger(value.partCount) || !positiveInteger(value.payloadBytes)) {
    throw new Error("投稿分卷清单格式无效");
  }
}

function assertExactNames(zip, names) {
  if (zip.size !== names.length || names.some((name) => !zip.has(name))) throw new Error("投稿 ZIP 结构无效");
}

function assertSafePath(value) {
  const path = String(value ?? "");
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("ZIP 内包含不安全路径");
  }
}

function assertSafeMediaPath(path, kind) {
  assertSafePath(path);
  const segments = "(?:[a-zA-Z0-9._-]+/)*[a-zA-Z0-9._-]+";
  const pattern = kind === "video"
    ? new RegExp(`^videos/${segments}\\.mp4$`, "i")
    : new RegExp(`^images/${segments}\\.(?:png|jpe?g|webp)$`, "i");
  if (!pattern.test(path)) throw new Error("媒体路径或扩展名不受支持");
}

function assertOptionalHttps(value) {
  if (!value) return;
  const url = new URL(String(value));
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("来源链接必须是安全的 HTTPS 地址");
}

function assertMediaSignature(bytes, kind, path) {
  const image = isPng(bytes) || isJpeg(bytes) || isWebp(bytes);
  const video = bytes.byteLength >= 12 && textAt(bytes, 4, 4) === "ftyp";
  if (kind === "image" && !image) throw new Error(`图片文件头无效：${path}`);
  if (kind === "video" && !video) throw new Error(`视频文件头无效：${path}`);
}

function isPng(bytes) {
  return bytes.byteLength >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}

function isJpeg(bytes) {
  return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isWebp(bytes) {
  return bytes.byteLength >= 12 && textAt(bytes, 0, 4) === "RIFF" && textAt(bytes, 8, 4) === "WEBP";
}

function textAt(bytes, offset, length) {
  return new TextDecoder("ascii").decode(bytes.subarray(offset, offset + length));
}

function extensionFor(path) {
  const match = String(path).match(/\.(png|jpe?g|webp)$/i);
  return match ? `.${match[1].toLowerCase()}` : ".bin";
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label}不是有效的 JSON`);
  }
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("投稿文件内容无效");
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value ?? ""));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function findEndRecord(view) {
  const minimum = Math.max(0, view.byteLength - 0xffff - 22);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) checksum = CRC_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", () => reject(new Error("审核环境缺少媒体检查工具")));
    child.on("close", (code) => code === 0
      ? resolvePromise(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || "媒体文件无法读取")));
  });
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  CRC_TABLE[index] = value >>> 0;
}

async function main() {
  const args = process.argv.slice(2);
  const files = [];
  let issueBodyPath = "";
  let reportPath = "";
  let payloadPath = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--file") files.push(args[++index]);
    else if (args[index] === "--issue-body") issueBodyPath = args[++index];
    else if (args[index] === "--report") reportPath = args[++index];
    else if (args[index] === "--payload") payloadPath = args[++index];
    else throw new Error(`未知参数：${args[index]}`);
  }
  const policy = JSON.parse(await readFile(DEFAULT_POLICY_PATH, "utf8"));
  if (issueBodyPath) {
    const body = await readFile(resolve(issueBodyPath), "utf8");
    const urls = extractOfficialAttachmentUrls(body);
    if (!urls.length) throw new Error("Issue 中没有找到 GitHub 官方投稿附件");
    if (urls.length > policy.maxTransportFiles) throw new Error("投稿附件数量超过安全上限");
    for (const url of urls) files.push(await downloadAttachment(url, policy));
  }
  let report;
  try {
    const result = await preflightSubmission(files, { policy });
    report = { ...result, payload: undefined };
    if (payloadPath) await writeFile(resolve(payloadPath), result.payload);
  } catch (error) {
    report = { ok: false, message: error.message || "投稿预检失败" };
    if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
    return;
  }
  if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await main();
