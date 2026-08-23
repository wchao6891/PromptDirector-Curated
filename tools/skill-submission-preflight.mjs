import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { extractOfficialAttachmentUrls, fetchOfficialAttachment, readStoredZip } from "./submission-preflight.mjs";
import { normalizeSkillCallName, PUBLIC_SKILL_LICENSE } from "../site/skill-catalog.js";

const LIMITS = { maxBytes: 16 * 1024 * 1024, maxFiles: 66, maxFileBytes: 1024 * 1024 };
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function preflightSkillSubmission(inputFiles) {
  if (!Array.isArray(inputFiles) || inputFiles.length !== 1) throw new Error("精选 Skill 投稿必须上传一个完整 ZIP");
  const input = await readInput(inputFiles[0]);
  const outer = readStoredZip(input.bytes, { maxBytes: LIMITS.maxBytes, maxFiles: 2, maxFileBytes: LIMITS.maxBytes });
  assertExactNames(outer, ["submission.json", "payload.zip"]);
  const manifest = parseJson(outer.get("submission.json"), "精选 Skill 投稿清单");
  const normalized = validateManifest(manifest);
  const payload = outer.get("payload.zip");
  if (payload.byteLength !== normalized.payloadBytes || sha256(payload) !== normalized.payloadSha256) throw new Error("精选 Skill 投稿清单与实际内容不一致");
  const files = readStoredZip(payload, LIMITS);
  if (files.size !== normalized.fileCount || !files.has("SKILL.md")) throw new Error("精选 Skill 投稿文件数量或 SKILL.md 不一致");
  const preview = [];
  for (const [path, bytes] of files) {
    if (path !== "SKILL.md" && !/^references\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md$/i.test(path)) {
      throw new Error(`精选 Skill 投稿包含不允许的文件：${path}`);
    }
    let text;
    try { text = decoder.decode(bytes); } catch { throw new Error(`精选 Skill 投稿不是有效 UTF-8 文本：${path}`); }
    const findings = findPrivacyRisks(text);
    if (findings.length) throw new Error(`精选 Skill 投稿包含隐私风险：${path}（${findings[0]}）`);
    preview.push({ path, text });
  }
  const skill = parseSkillFrontmatter(preview.find((file) => file.path === "SKILL.md")?.text);
  if (skill.name !== normalized.skillId) throw new Error("SKILL.md 身份与投稿清单不一致");
  const digest = sha256(Buffer.from(preview.map((file) => `${file.path}\0${file.text}\0`).join("")));
  if (digest !== normalized.digest) throw new Error("精选 Skill 投稿全文摘要不一致");
  return {
    ok: true,
    skillId: normalized.skillId,
    callName: normalized.callName,
    title: normalized.title,
    author: normalized.author,
    license: normalized.license,
    summary: normalized.summary,
    fileCount: files.size,
    digest,
    payload
  };
}

function validateManifest(value) {
  if (value?.authorId !== undefined || value?.skillVersion !== undefined || value?.catalogId !== undefined) {
    throw new Error("稳定作者编号、发布版本和目录编号只能由人工审核发布阶段确定");
  }
  const skillId = portableId(value?.skillId);
  const callName = normalizeSkillCallName(value?.callName);
  const title = clean(value?.title);
  const author = clean(value?.author);
  const license = clean(value?.license);
  const summary = clean(value?.summary);
  const digest = String(value?.digest ?? "").toLocaleLowerCase("en-US");
  const payloadSha256 = String(value?.payloadSha256 ?? "").toLocaleLowerCase("en-US");
  const fileCount = positiveInteger(value?.fileCount);
  const payloadBytes = positiveInteger(value?.payloadBytes);
  if (license !== PUBLIC_SKILL_LICENSE) throw new Error(`精选 Skill 投稿许可必须是 ${PUBLIC_SKILL_LICENSE}`);
  if (value?.format !== "prompt-director-curated-skill-submission" || value.version !== 1 || !skillId || !title ||
      !author || value.reviewStatus !== "pending" || !summary || !isHash(digest) || !isHash(payloadSha256) || !fileCount || !payloadBytes) {
    throw new Error("精选 Skill 投稿清单格式无效");
  }
  return { skillId, callName, title, author, license, summary, digest, payloadSha256, fileCount, payloadBytes };
}

function parseSkillFrontmatter(markdown) {
  const match = String(markdown ?? "").match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md 缺少 YAML frontmatter");
  const name = portableId(match[1].match(/^name:\s*["']?([^\n"']+)/m)?.[1]);
  const description = clean(match[1].match(/^description:\s*["']?([^\n"']+)/m)?.[1]);
  if (!name || !description || !normalizeMarkdown(match[2])) throw new Error("SKILL.md 缺少有效 name、description 或正文");
  return { name, description };
}

function findPrivacyRisks(text) {
  const rules = [
    /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}["']?/iu,
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/u,
    /(?:\/Users\/[^\s/]+|[A-Za-z]:\\Users\\[^\s\\]+)/u,
    /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(?=[:/\s]|$)/u,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu
  ];
  return rules.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

async function readInput(value) {
  if (value instanceof Uint8Array) return { name: "submission.zip", bytes: value };
  if (value?.bytes) return { name: String(value.name ?? "submission.zip"), bytes: value.bytes instanceof Uint8Array ? value.bytes : new Uint8Array(value.bytes) };
  const path = resolve(String(value));
  return { name: basename(path), bytes: new Uint8Array(await readFile(path)) };
}

export async function downloadSkillSubmissionAttachment(url) {
  const response = await fetchOfficialAttachment(url);
  if (!response.ok) throw new Error(`GitHub 附件下载失败（${response.status}）`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > LIMITS.maxBytes) throw new Error("精选 Skill 投稿附件超过安全上限");
  return { name: basename(new URL(url).pathname), bytes };
}

export async function loadSkillSubmissionFromIssueBody(issueBody) {
  const urls = extractOfficialAttachmentUrls(String(issueBody ?? ""));
  const files = await Promise.all(urls.map(downloadSkillSubmissionAttachment));
  return preflightSkillSubmission(files);
}

function assertExactNames(files, names) { if (files.size !== names.length || names.some((name) => !files.has(name))) throw new Error("精选 Skill 投稿 ZIP 结构无效"); }
function parseJson(bytes, label) { try { return JSON.parse(decoder.decode(bytes)); } catch { throw new Error(`${label}不是有效 JSON`); } }
function portableId(value) { const text = clean(value).toLocaleLowerCase("en-US"); return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text) && text.length <= 63 ? text : ""; }
function normalizeMarkdown(value) { return String(value ?? "").replace(/\r\n?/g, "\n").trim(); }
function clean(value) { return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(); }
function positiveInteger(value) { const number = Math.floor(Number(value) || 0); return number > 0 ? number : 0; }
function isHash(value) { return /^[a-f0-9]{64}$/.test(value); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const issueBodyPath = args.get("--issue-body");
  const reportPath = args.get("--report");
  let report;
  try {
    if (!issueBodyPath) throw new Error("缺少 GitHub Issue 内容");
    const result = await loadSkillSubmissionFromIssueBody(await readFile(issueBodyPath, "utf8"));
    report = { ok: true, skillId: result.skillId, author: result.author, license: result.license, fileCount: result.fileCount };
  } catch (error) {
    report = { ok: false, message: error.message || "精选 Skill 投稿预检失败" };
    if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await main();
