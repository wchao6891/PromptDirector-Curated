import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { normalizeSiteSkillCatalog, normalizeSkillCallName, PUBLIC_SKILL_LICENSE } from "./curated-skill-site-data.mjs";
import { loadSkillSubmissionFromIssueBody, preflightSkillSubmission } from "./skill-submission-preflight.mjs";

const CATALOG_FORMAT = "prompt-director-curated-skills";
const CATALOG_VERSION = 1;

export async function prepareSkillPublication({ submissionFiles, catalog: catalogValue, repository, reviewedAt }) {
  const submission = await preflightSkillSubmission(submissionFiles);
  return buildPublication(submission, catalogValue, repository, reviewedAt);
}

export function buildPublication(submission, catalogValue, repositoryValue, reviewedAtValue) {
  const catalog = normalizeSiteSkillCatalog(structuredClone(catalogValue));
  const repository = validRepository(repositoryValue);
  const reviewedAt = validIso(reviewedAtValue);
  if (submission?.license !== PUBLIC_SKILL_LICENSE || !(submission.payload instanceof Uint8Array)) {
    throw new Error("精选 Skill 投稿尚未通过完整预检");
  }
  const sha256 = hash(submission.payload);
  const existing = catalog.skills.find((item) => item.skillId === submission.skillId && item.sha256 === sha256);
  if (existing) {
    return {
      status: "existing",
      item: existing,
      catalog,
      asset: { bytes: submission.payload, sha256, archiveBytes: submission.payload.byteLength },
      release: releaseIdentity(existing.skillId, existing.version, repository)
    };
  }

  const existingVersions = catalog.skills.filter((item) => item.skillId === submission.skillId);
  if (existingVersions.some((item) => authorKey(item.author) !== authorKey(submission.author))) {
    throw new Error("同一精选 Skill 的公开署名不一致，拒绝替换稳定作者身份");
  }
  const version = nextPatchVersion(existingVersions);
  const release = releaseIdentity(submission.skillId, version, repository);
  const callName = submission.callName === submission.skillId
    ? normalizeSkillCallName(submission.title)
    : normalizeSkillCallName(submission.callName);
  const item = {
    id: `${submission.skillId}@${version}`,
    skillId: submission.skillId,
    version,
    title: submission.title,
    callName,
    authorId: existingVersions[0]?.authorId ?? stableAuthorId(submission.author),
    author: submission.author,
    license: PUBLIC_SKILL_LICENSE,
    reviewStatus: "approved",
    reviewedAt,
    summary: submission.summary,
    downloadUrl: release.downloadUrl,
    sha256,
    archiveBytes: submission.payload.byteLength,
    order: Math.max(0, ...catalog.skills.map((itemValue) => itemValue.order)) + 1
  };
  const nextCatalog = normalizeSiteSkillCatalog({
    format: CATALOG_FORMAT,
    version: CATALOG_VERSION,
    updatedAt: reviewedAt,
    skills: [...catalog.skills, item]
  });
  return {
    status: "publish",
    item,
    catalog: nextCatalog,
    asset: { bytes: submission.payload, sha256, archiveBytes: submission.payload.byteLength },
    release
  };
}

function nextPatchVersion(items) {
  if (!items.length) return "1.0.0";
  const versions = items.map((item) => {
    const match = String(item.version).match(/^(\d+)\.(\d+)\.(\d+)(?:-[a-z0-9.-]+)?$/i);
    if (!match) throw new Error("现有精选 Skill 版本无法安全递增");
    const components = match.slice(1).map(Number);
    if (components.some((component) => !Number.isSafeInteger(component))) {
      throw new Error("现有精选 Skill 版本超出安全范围");
    }
    return components;
  }).sort(compareVersion);
  const [major, minor, patch] = versions.at(-1);
  if (!Number.isSafeInteger(patch) || patch >= Number.MAX_SAFE_INTEGER) throw new Error("精选 Skill 补丁版本已超出安全范围");
  return `${major}.${minor}.${patch + 1}`;
}

function compareVersion(left, right) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function stableAuthorId(author) {
  return `author-${hash(Buffer.from(authorKey(author))).slice(0, 12)}`;
}

function authorKey(author) {
  return String(author).normalize("NFKC").toLocaleLowerCase("en-US");
}

function releaseIdentity(skillId, version, repository) {
  const tag = `skill-${skillId}-v${version}`;
  const assetName = `${skillId}-${version}.zip`;
  return {
    tag,
    assetName,
    downloadUrl: `https://github.com/${repository}/releases/download/${tag}/${assetName}`
  };
}

function validRepository(value) {
  const text = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) throw new Error("GitHub 仓库标识无效");
  return text;
}

function validIso(value) {
  const text = String(value ?? "").trim();
  if (!text || Number.isNaN(Date.parse(text))) throw new Error("精选 Skill 审核时间无效");
  return new Date(text).toISOString();
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

async function writeAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

async function main() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  const issueBodyPath = requiredArg(args, "--issue-body");
  const catalogPath = resolve(requiredArg(args, "--catalog"));
  const assetDirectory = resolve(requiredArg(args, "--asset-directory"));
  const resultPath = resolve(requiredArg(args, "--result"));
  const submission = await loadSkillSubmissionFromIssueBody(await readFile(issueBodyPath, "utf8"));
  const publication = buildPublication(
    submission,
    JSON.parse(await readFile(catalogPath, "utf8")),
    requiredArg(args, "--repository"),
    requiredArg(args, "--reviewed-at")
  );
  const assetPath = join(assetDirectory, publication.release.assetName);
  await writeAtomic(assetPath, publication.asset.bytes);
  if (publication.status === "publish") {
    await writeAtomic(catalogPath, `${JSON.stringify(publication.catalog, null, 2)}\n`);
  }
  const result = {
    status: publication.status,
    skillId: publication.item.skillId,
    version: publication.item.version,
    tag: publication.release.tag,
    assetName: publication.release.assetName,
    assetPath,
    sha256: publication.asset.sha256,
    archiveBytes: publication.asset.archiveBytes
  };
  await writeAtomic(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${result.status}: ${result.skillId}@${result.version}\n`);
}

function requiredArg(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`缺少参数：${name}`);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await main();
}
