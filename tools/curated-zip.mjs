import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const DOS_DATE = 0x0021;
const encoder = new TextEncoder();

export async function writePromptDirectorZip(outputPathValue, rootValue, fileNamesValue) {
  const outputPath = resolve(outputPathValue);
  const root = resolve(rootValue);
  const rootPrefix = `${root}${sep}`;
  const fileNames = [...fileNamesValue];
  if (!fileNames.length || fileNames.length > 0xffff) throw new Error("ZIP 文件数量无效");

  const records = [];
  let offset = 0;
  for (const nameValue of fileNames) {
    const name = normalizeArchivePath(nameValue);
    const path = resolve(root, name);
    if (!path.startsWith(rootPrefix)) throw new Error(`ZIP 文件超出构建目录：${name}`);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`ZIP 条目不是文件：${name}`);
    ensureUint32(info.size, "ZIP 单个文件过大");
    const nameBytes = encoder.encode(name);
    const checksum = await crc32File(path);
    records.push({ name, nameBytes, path, size: info.size, checksum, offset });
    offset += 30 + nameBytes.byteLength + info.size;
    ensureUint32(offset, "ZIP 文件过大");
  }

  const localParts = [];
  const centralParts = [];
  for (const record of records) {
    localParts.push(makeLocalHeader(record.nameBytes, record.size, record.checksum), record.nameBytes, record.path);
    centralParts.push(makeCentralHeader(record.nameBytes, record.size, record.checksum, record.offset), record.nameBytes);
  }
  const centralSize = centralParts.reduce((sum, part) => sum + (typeof part === "string" ? 0 : part.byteLength), 0);
  ensureUint32(centralSize, "ZIP 目录过大");

  const handle = await open(outputPath, "w");
  try {
    let position = 0;
    for (const part of localParts) {
      if (typeof part === "string") {
        position += await copyFileToHandle(part, handle, position);
      } else {
        await handle.write(part, 0, part.byteLength, position);
        position += part.byteLength;
      }
    }
    for (const part of centralParts) {
      await handle.write(part, 0, part.byteLength, position);
      position += part.byteLength;
    }
    const end = makeEndRecord(records.length, centralSize, offset);
    await handle.write(end, 0, end.byteLength, position);
  } finally {
    await handle.close();
  }
}

function normalizeArchivePath(value) {
  const path = String(value ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("ZIP 文件路径无效");
  }
  return path;
}

function makeLocalHeader(name, size, checksum) {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, STORE_METHOD, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, DOS_DATE, true);
  view.setUint32(14, checksum, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.byteLength, true);
  return bytes;
}

function makeCentralHeader(name, size, checksum, offset) {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, STORE_METHOD, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, DOS_DATE, true);
  view.setUint32(16, checksum, true);
  view.setUint32(20, size, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.byteLength, true);
  view.setUint32(42, offset, true);
  return bytes;
}

function makeEndRecord(count, centralSize, centralOffset) {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, centralSize, true);
  view.setUint32(16, centralOffset, true);
  return bytes;
}

async function copyFileToHandle(path, handle, startPosition) {
  let position = startPosition;
  for await (const chunk of createReadStream(path)) {
    await handle.write(chunk, 0, chunk.length, position);
    position += chunk.length;
  }
  return position - startPosition;
}

async function crc32File(path) {
  let crc = 0xffffffff;
  for await (const chunk of createReadStream(path)) {
    for (const byte of chunk) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function ensureUint32(value, message) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(message);
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  CRC_TABLE[index] = value >>> 0;
}
