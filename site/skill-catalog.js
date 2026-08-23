export const PUBLIC_SKILL_LICENSE = "CC BY 4.0";

const FORMAT = "prompt-director-curated-skills";
const VERSION = 1;
const RELEASE_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

export function normalizeSiteSkillCatalog(value) {
  if (value?.format !== FORMAT || value.version !== VERSION || !Array.isArray(value.skills)) throw new Error("skills-catalog.json 格式无效");
  const ids = new Set();
  const versions = new Set();
  const orders = new Set();
  const skills = value.skills.map(normalizeItem).map((item) => {
    const versionKey = `${item.skillId}@${item.version}`;
    if (ids.has(item.id) || versions.has(versionKey) || orders.has(item.order)) throw new Error("精选 Skill 编号、版本或排序重复");
    ids.add(item.id);
    versions.add(versionKey);
    orders.add(item.order);
    return item;
  }).toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return { format: FORMAT, version: VERSION, updatedAt: validIso(value.updatedAt, "精选 Skill 目录更新时间无效"), skills };
}

function normalizeItem(value = {}) {
  const id = clean(value.id);
  const skillId = portableId(value.skillId);
  const version = clean(value.version);
  const title = clean(value.title);
  const callName = normalizeSkillCallName(value.callName);
  const authorId = portableId(value.authorId);
  const author = clean(value.author);
  const license = clean(value.license);
  const reviewStatus = clean(value.reviewStatus);
  const reviewedAt = validIso(value.reviewedAt, "精选 Skill 审核时间无效");
  const summary = clean(value.summary);
  const downloadUrl = trustedDownloadUrl(value.downloadUrl);
  const sha256 = String(value.sha256 ?? "").toLocaleLowerCase("en-US");
  const archiveBytes = positiveInteger(value.archiveBytes);
  const order = positiveInteger(value.order);
  const expectedId = skillId && version ? `${skillId}@${version}` : "";
  if (!id || id !== expectedId || !skillId || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version) || !title || !callName || !authorId || !author || license !== PUBLIC_SKILL_LICENSE ||
      reviewStatus !== "approved" || !reviewedAt || !summary || !downloadUrl || !/^[a-f0-9]{64}$/.test(sha256) || !archiveBytes || !order) {
    throw new Error("精选 Skill 编号、许可、发布必填字段或人工审核状态无效");
  }
  return { id, skillId, version, title, callName, authorId, author, license, reviewStatus, reviewedAt, summary, downloadUrl, sha256, archiveBytes, order };
}

function trustedDownloadUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" && RELEASE_HOSTS.has(url.hostname) && !url.username && !url.password && !url.search && !url.hash ? url.href : "";
  } catch { return ""; }
}

export function normalizeSkillCallName(value) {
  const raw = String(value ?? "");
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error("精选 Skill 调用名不能包含控制字符");
  const name = raw.trim();
  if (!name || name.length > 80 || /[\\/]/.test(name)) throw new Error("精选 Skill 调用名必须为不含斜杠的 1 至 80 个字符");
  return name;
}

function portableId(value) { const text = clean(value).toLocaleLowerCase("en-US"); return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(text) && text.length <= 63 ? text : ""; }
function clean(value) { return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim(); }
function validIso(value, message) { const text = clean(value); if (!text || Number.isNaN(Date.parse(text))) throw new Error(message); return new Date(text).toISOString(); }
function positiveInteger(value) { const number = Math.floor(Number(value) || 0); return number > 0 ? number : 0; }
