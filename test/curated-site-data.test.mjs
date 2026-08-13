import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeSiteCatalog, normalizeSiteMediaManifest, normalizeSiteMetrics, normalizeSitePreview } from "../tools/curated-site-data.mjs";
import { assertSafeArchiveNames } from "../tools/build-site-previews.mjs";
import { syncReleaseMetrics } from "../tools/sync-release-metrics.mjs";

function theme(overrides = {}) {
  return {
    id: "featured:test",
    title: "测试精选",
    order: 1,
    type: "image_prompt",
    packageId: "test-featured",
    packageVersion: "1.0.0",
    authorId: "promptdirector-editorial",
    author: "PromptDirector 编辑精选",
    license: "PromptDirector 原创",
    updatedAt: "2026-08-10T00:00:00.000Z",
    coverUrl: "https://wchao6891.github.io/PromptDirector-Curated/covers/test.webp",
    previewUrl: "https://wchao6891.github.io/PromptDirector-Curated/previews/test-featured/preview.json",
    downloadUrl: "https://github.com/wchao6891/PromptDirector-Curated/releases/download/test-1.0.0/test.zip",
    sha256: "a".repeat(64),
    archiveBytes: 1024,
    caseCount: 1,
    imageCount: 1,
    videoCount: 0,
    summary: "",
    ...overrides
  };
}

function catalog(overrides = {}) {
  return {
    format: "prompt-director-curated",
    version: 2,
    updatedAt: "2026-08-10T00:00:00.000Z",
    themes: [theme()],
    ...overrides
  };
}

test("catalog requires stable authors and trusted preview URLs without changing version 2", () => {
  const value = normalizeSiteCatalog(catalog());
  assert.equal(value.version, 2);
  assert.equal(value.themes[0].authorId, "promptdirector-editorial");
  assert.throws(() => normalizeSiteCatalog(catalog({ themes: [theme({ previewUrl: "https://attacker.example/preview.json" })] })), /预览地址无效/);
});

test("preview files bind reviewed cases to the exact catalog package version", () => {
  const value = normalizeSitePreview({
    format: "prompt-director-curated-preview",
    version: 1,
    catalogId: "featured:test",
    packageId: "test-featured",
    packageVersion: "1.0.0",
    entries: [{
      id: "case-one",
      title: "案例一",
      text: "真实提示词",
      author: "@creator",
      rights: "权利归原作者",
      sourceUrl: "https://source.example/case-one",
      mediaKind: "image",
      previewImageUrl: "https://wchao6891.github.io/PromptDirector-Curated/previews/test-featured/media/case-one.webp",
      width: 1200,
      height: 900
    }]
  }, theme());
  assert.equal(value.entries[0].text, "真实提示词");
  assert.deepEqual(normalizeSitePreview(value, theme()), value);
  assert.throws(() => normalizeSitePreview({ ...value, packageVersion: "2.0.0" }, theme()), /版本不一致/);
  assert.throws(() => normalizeSitePreview({
    ...value,
    entries: [{ ...value.entries[0], sourceUrl: "http://source.example/case-one" }]
  }, theme()), /来源地址无效/);
});

test("media manifests bind each reviewed video to one immutable release asset", () => {
  const videoTheme = theme({ type: "video_prompt", videoCount: 1 });
  const value = normalizeSiteMediaManifest({
    format: "prompt-director-curated-media",
    version: 1,
    updatedAt: "2026-08-14T00:00:00.000Z",
    packages: [{
      packageId: videoTheme.packageId,
      packageVersion: videoTheme.packageVersion,
      releaseTag: "media-test-featured-1.0.0",
      entries: [{
        sourceEntryId: "case-one",
        videoUrl: `https://github.com/wchao6891/PromptDirector-Curated/releases/download/media-test-featured-1.0.0/${"b".repeat(64)}.mp4`,
        videoSha256: "b".repeat(64),
        videoBytes: 2048,
        videoMimeType: "video/mp4"
      }]
    }]
  }, catalog({ themes: [videoTheme] }));
  assert.equal(value.packages[0].entries[0].sourceEntryId, "case-one");
  assert.throws(() => normalizeSiteMediaManifest({ ...value, packages: [{ ...value.packages[0], entries: [] }] }, catalog({ themes: [videoTheme] })), /视频数量不一致/);
});

test("preview builds reject paths that could escape or publish unreviewed content", () => {
  assert.throws(() => assertSafeArchiveNames(["library.json", "../escape.webp"]), /不安全路径/);
  assert.throws(() => assertSafeArchiveNames(["library.json", "payload.html"]), /未审核文件/);
  assert.throws(() => assertSafeArchiveNames(["library.json", "images/case.webp", "images/case.webp"]), /重复路径/);
});

test("metrics require a real count for every catalog package", () => {
  assert.deepEqual(normalizeSiteMetrics({
    format: "prompt-director-curated-metrics",
    version: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
    downloads: { "featured:test": 17 }
  }, catalog()).downloads, { "featured:test": 17 });
  assert.throws(() => normalizeSiteMetrics({
    format: "prompt-director-curated-metrics",
    version: 1,
    updatedAt: "2026-08-10T00:00:00.000Z",
    downloads: {}
  }, catalog()), /缺少真实下载量/);
});

test("release metric sync refuses a digest mismatch and preserves the previous file", async () => {
  const root = await mkdtemp(join(tmpdir(), "curated-metrics-test-"));
  const catalogPath = join(root, "catalog.json");
  const metricsPath = join(root, "metrics.json");
  await writeFile(catalogPath, JSON.stringify(catalog()));
  await writeFile(metricsPath, "previous-real-data\n");
  try {
    await assert.rejects(() => syncReleaseMetrics({
      catalogPath,
      metricsPath,
      fetchImpl: async () => ({
        ok: true,
        json: async () => [{ assets: [{
          browser_download_url: theme().downloadUrl,
          download_count: 9,
          digest: `sha256:${"b".repeat(64)}`
        }] }]
      })
    }), /摘要与目录不一致/);
    assert.equal(await readFile(metricsPath, "utf8"), "previous-real-data\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public cases use visual-only masonry cards and a copy-only case detail", async () => {
  const [app, html, styles] = await Promise.all([
    readFile(new URL("../site/app.js", import.meta.url), "utf8"),
    readFile(new URL("../site/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/styles.css", import.meta.url), "utf8")
  ]);
  assert.match(app, /import \{ createStableMasonry \} from "\.\/masonry\.js"/);
  assert.match(app, /const CASE_PAGE_SIZE = 24/);
  assert.match(html, /id="case-detail-drawer"/);
  const card = app.slice(app.indexOf("function createCaseCard"), app.indexOf("function openCaseDetail"));
  assert.match(card, /openCaseDetail\(item, entry, card\)/);
  assert.doesNotMatch(card, /case-footer|case-copy-action|button/);
  const detail = app.slice(app.indexOf("function renderCaseDetail"), app.indexOf("async function loadPreview"));
  assert.match(detail, /element\("pre", "case-detail-prompt", entry\.text\)/);
  assert.match(detail, /actions\.append\(copy\)/);
  assert.doesNotMatch(detail, /保存到案例库|case-save-action/);
  assert.match(styles, /\.case-list\s*\{[^}]*position:\s*relative/);
  assert.match(styles, /\.case-card\s*\{[^}]*position:\s*absolute/);
});
