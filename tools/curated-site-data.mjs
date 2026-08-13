const CATALOG_FORMAT = "prompt-director-curated";
const CATALOG_VERSION = 2;
const PREVIEW_FORMAT = "prompt-director-curated-preview";
const PREVIEW_VERSION = 1;
const METRICS_FORMAT = "prompt-director-curated-metrics";
const METRICS_VERSION = 1;
const MEDIA_FORMAT = "prompt-director-curated-media";
const MEDIA_VERSION = 1;
const SITE_HOST = "wchao6891.github.io";
const RELEASE_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com"
]);

export function normalizeSiteCatalog(value) {
  if (value?.format !== CATALOG_FORMAT || value.version !== CATALOG_VERSION || !Array.isArray(value.themes)) {
    throw new Error("catalog.json 格式无效");
  }
  const ids = new Set();
  const packages = new Set();
  const orders = new Set();
  const themes = value.themes.map((item) => {
    const normalized = normalizeTheme(item);
    const packageKey = `${normalized.packageId}@${normalized.packageVersion}`;
    if (ids.has(normalized.id) || packages.has(packageKey)) throw new Error(`精选编号重复：${normalized.id}`);
    if (orders.has(normalized.order)) throw new Error(`主题排序重复：${normalized.order}`);
    ids.add(normalized.id);
    packages.add(packageKey);
    orders.add(normalized.order);
    return normalized;
  });
  return {
    format: CATALOG_FORMAT,
    version: CATALOG_VERSION,
    updatedAt: validIso(value.updatedAt, "目录更新时间无效"),
    themes: themes.toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id))
  };
}

export function normalizeSitePreview(value, themeValue) {
  const theme = normalizeTheme(themeValue);
  if (value?.format !== PREVIEW_FORMAT || value.version !== PREVIEW_VERSION || !Array.isArray(value.entries)) {
    throw new Error(`${theme.id} 的预览格式无效`);
  }
  if (clean(value.catalogId) !== theme.id || clean(value.packageId) !== theme.packageId || clean(value.packageVersion) !== theme.packageVersion) {
    throw new Error(`${theme.id} 的预览与目录版本不一致`);
  }
  if (value.entries.length !== theme.caseCount) throw new Error(`${theme.id} 的预览案例数量不一致`);
  const ids = new Set();
  const entries = value.entries.map((entry) => {
    const id = clean(entry?.id);
    const title = clean(entry?.title);
    const text = cleanPrompt(entry?.text);
    const author = clean(entry?.author);
    const rights = clean(entry?.rights);
    const mediaKind = ["image", "video"].includes(entry?.mediaKind) ? entry.mediaKind : "";
    const previewImageUrl = trustedUrl(entry?.previewImageUrl, new Set([SITE_HOST]), "预览图片地址无效");
    const sourceUrl = optionalHttpsUrl(entry?.sourceUrl);
    const hasVideoAsset = Boolean(clean(entry?.videoUrl) || clean(entry?.videoSha256) || clean(entry?.videoMimeType) || Number(entry?.videoBytes) > 0);
    const videoUrl = hasVideoAsset ? trustedUrl(entry?.videoUrl, RELEASE_HOSTS, "精选视频地址无效") : "";
    const videoSha256 = hasVideoAsset ? clean(entry?.videoSha256).toLocaleLowerCase("en-US") : "";
    const videoBytes = hasVideoAsset ? positiveInteger(entry?.videoBytes, "精选视频大小无效") : 0;
    const videoMimeType = hasVideoAsset ? clean(entry?.videoMimeType) : "";
    if (!id || !title || !text || !author || !rights || !mediaKind) throw new Error(`${theme.id} 的预览案例缺少字段`);
    if (hasVideoAsset && (mediaKind !== "video" || !/^[a-f0-9]{64}$/.test(videoSha256) || videoMimeType !== "video/mp4")) {
      throw new Error(`${theme.id} 的精选视频字段无效`);
    }
    if (ids.has(id)) throw new Error(`${theme.id} 的预览包含重复案例`);
    ids.add(id);
    return {
      id,
      title,
      text,
      author,
      rights,
      sourceUrl,
      mediaKind,
      previewImageUrl,
      ...(hasVideoAsset ? { videoUrl, videoSha256, videoBytes, videoMimeType } : {}),
      width: positiveInteger(entry?.width, "预览宽度无效"),
      height: positiveInteger(entry?.height, "预览高度无效")
    };
  });
  return {
    format: PREVIEW_FORMAT,
    version: PREVIEW_VERSION,
    catalogId: theme.id,
    packageId: theme.packageId,
    packageVersion: theme.packageVersion,
    entries
  };
}

export function normalizeSiteMetrics(value, catalogValue) {
  const catalog = normalizeSiteCatalog(catalogValue);
  if (value?.format !== METRICS_FORMAT || value.version !== METRICS_VERSION || !value.downloads || Array.isArray(value.downloads)) {
    throw new Error("metrics.json 格式无效");
  }
  const downloads = {};
  for (const theme of catalog.themes) {
    const count = value.downloads[theme.id];
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${theme.id} 缺少真实下载量`);
    downloads[theme.id] = count;
  }
  return {
    format: METRICS_FORMAT,
    version: METRICS_VERSION,
    updatedAt: validIso(value.updatedAt, "下载指标更新时间无效"),
    downloads
  };
}

export function normalizeSiteMediaManifest(value, catalogValue) {
  const catalog = normalizeSiteCatalog(catalogValue);
  if (value?.format !== MEDIA_FORMAT || value.version !== MEDIA_VERSION || !Array.isArray(value.packages)) {
    throw new Error("精选媒体清单格式无效");
  }
  const catalogPackages = new Map(catalog.themes.map((theme) => [`${theme.packageId}@${theme.packageVersion}`, theme]));
  const packageKeys = new Set();
  const packages = value.packages.map((item) => {
    const packageId = safeId(item?.packageId);
    const packageVersion = clean(item?.packageVersion);
    const packageKey = `${packageId}@${packageVersion}`;
    const theme = catalogPackages.get(packageKey);
    if (!theme || theme.videoCount < 1 || packageKeys.has(packageKey)) throw new Error(`精选媒体包无效：${packageKey}`);
    const releaseTag = safeId(item?.releaseTag);
    const ids = new Set();
    const entries = Array.isArray(item?.entries) ? item.entries.map((entry) => {
      const sourceEntryId = clean(entry?.sourceEntryId);
      const videoUrl = trustedUrl(entry?.videoUrl, RELEASE_HOSTS, "精选视频地址无效");
      const videoSha256 = clean(entry?.videoSha256).toLocaleLowerCase("en-US");
      const videoBytes = positiveInteger(entry?.videoBytes, "精选视频大小无效");
      const videoMimeType = clean(entry?.videoMimeType);
      if (!sourceEntryId || ids.has(sourceEntryId) || !/^[a-f0-9]{64}$/.test(videoSha256) || videoMimeType !== "video/mp4") {
        throw new Error(`${packageKey} 的精选媒体条目无效`);
      }
      ids.add(sourceEntryId);
      return { sourceEntryId, videoUrl, videoSha256, videoBytes, videoMimeType };
    }) : [];
    if (entries.length !== theme.videoCount) throw new Error(`${packageKey} 的精选视频数量不一致`);
    packageKeys.add(packageKey);
    return { packageId, packageVersion, releaseTag, entries };
  });
  return {
    format: MEDIA_FORMAT,
    version: MEDIA_VERSION,
    updatedAt: validIso(value.updatedAt, "媒体清单更新时间无效"),
    packages
  };
}

export function normalizeTheme(value = {}) {
  const required = ["id", "title", "type", "packageId", "packageVersion", "authorId", "author", "license"];
  if (required.some((key) => !clean(value[key]))) throw new Error("目录条目缺少必填字段");
  if (!["editorial", "image_prompt", "video_prompt"].includes(value.type)) throw new Error(`不支持的精选类型：${value.type}`);
  const sha256 = clean(value.sha256).toLocaleLowerCase("en-US");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`校验值无效：${value.id}`);
  return {
    id: clean(value.id),
    title: clean(value.title),
    type: value.type,
    packageId: safeId(value.packageId),
    packageVersion: clean(value.packageVersion),
    authorId: safeId(value.authorId),
    author: clean(value.author),
    license: clean(value.license),
    updatedAt: validIso(value.updatedAt, `更新时间无效：${value.id}`),
    coverUrl: trustedUrl(value.coverUrl, new Set([SITE_HOST]), "精选封面地址无效"),
    previewUrl: trustedUrl(value.previewUrl, new Set([SITE_HOST]), "精选预览地址无效"),
    downloadUrl: trustedUrl(value.downloadUrl, RELEASE_HOSTS, "精选下载地址无效"),
    sha256,
    archiveBytes: positiveInteger(value.archiveBytes, "案例包大小无效"),
    caseCount: nonNegativeInteger(value.caseCount, "案例数量无效"),
    imageCount: nonNegativeInteger(value.imageCount, "图片数量无效"),
    videoCount: nonNegativeInteger(value.videoCount, "视频数量无效"),
    summary: clean(value.summary),
    order: positiveInteger(value.order, "主题排序无效")
  };
}

export function cleanPrompt(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

export function clean(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

export function safeId(value) {
  const id = clean(value);
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") throw new Error(`编号无效：${id}`);
  return id;
}

function trustedUrl(value, hosts, message) {
  const url = safeHttpsUrl(value);
  if (!url || !hosts.has(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error(message);
  return url.href;
}

function optionalHttpsUrl(value) {
  if (!clean(value)) return "";
  const url = safeHttpsUrl(value);
  if (!url || url.username || url.password) throw new Error("案例来源地址无效");
  return url.href;
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(clean(value));
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function validIso(value, message) {
  const text = clean(value);
  if (!text || Number.isNaN(Date.parse(text))) throw new Error(message);
  return new Date(text).toISOString();
}

function positiveInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(message);
  return value;
}

function nonNegativeInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(message);
  return value;
}
