import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writePromptDirectorZip } from "../tools/curated-zip.mjs";
import { prepareSkillPublication } from "../tools/approve-skill-submission.mjs";

const EMPTY_CATALOG = {
  format: "prompt-director-curated-skills",
  version: 1,
  updatedAt: "2026-08-23T00:00:00.000Z",
  skills: []
};

test("approved submission becomes a deterministic immutable 1.0.0 release", async () => {
  const fixture = await makeFixture();
  try {
    const result = await prepareSkillPublication({
      submissionFiles: [{ name: "skill-submission.zip", bytes: fixture.outer }],
      catalog: EMPTY_CATALOG,
      repository: "wchao6891/PromptDirector-Curated",
      reviewedAt: "2026-08-23T08:30:00.000Z"
    });

    assert.equal(result.status, "publish");
    assert.equal(result.item.id, "composition-method@1.0.0");
    assert.equal(result.item.title, "构图方法");
    assert.equal(result.item.callName, "构图方法");
    assert.equal(result.item.author, "Creator One");
    assert.match(result.item.authorId, /^author-[a-f0-9]{12}$/);
    assert.equal(result.item.reviewStatus, "approved");
    assert.equal(result.release.tag, "skill-composition-method-v1.0.0");
    assert.equal(result.release.assetName, "composition-method-1.0.0.zip");
    assert.equal(result.item.downloadUrl, "https://github.com/wchao6891/PromptDirector-Curated/releases/download/skill-composition-method-v1.0.0/composition-method-1.0.0.zip");
    assert.deepEqual(result.asset.bytes, fixture.payload);
    assert.equal(result.item.sha256, hash(fixture.payload));
    assert.equal(result.catalog.skills.length, 1);
  } finally { await fixture.cleanup(); }
});

test("changed payload safely advances the highest patch version", async () => {
  const first = await makeFixture();
  const changed = await makeFixture({ body: "Use depth and contrast." });
  try {
    const published = await prepareSkillPublication({
      submissionFiles: [{ bytes: first.outer }],
      catalog: EMPTY_CATALOG,
      repository: "wchao6891/PromptDirector-Curated",
      reviewedAt: "2026-08-23T08:30:00.000Z"
    });
    const next = await prepareSkillPublication({
      submissionFiles: [{ bytes: changed.outer }],
      catalog: published.catalog,
      repository: "wchao6891/PromptDirector-Curated",
      reviewedAt: "2026-08-24T08:30:00.000Z"
    });

    assert.equal(next.status, "publish");
    assert.equal(next.item.id, "composition-method@1.0.1");
    assert.equal(next.item.order, 2);
    assert.equal(next.item.authorId, published.item.authorId);
    assert.equal(next.release.tag, "skill-composition-method-v1.0.1");
    assert.equal(next.catalog.skills.length, 2);
  } finally {
    await first.cleanup();
    await changed.cleanup();
  }
});

test("a readable non-Latin call name is kept independently from portable skill identity", async () => {
  const fixture = await makeFixture({ callName: "镜头节奏" });
  try {
    const result = await prepareSkillPublication({
      submissionFiles: [{ bytes: fixture.outer }],
      catalog: EMPTY_CATALOG,
      repository: "wchao6891/PromptDirector-Curated",
      reviewedAt: "2026-08-23T08:30:00.000Z"
    });
    assert.equal(result.item.skillId, "composition-method");
    assert.equal(result.item.callName, "镜头节奏");
  } finally { await fixture.cleanup(); }
});

test("the same approved payload is idempotent and does not rewrite the catalog", async () => {
  const fixture = await makeFixture();
  try {
    const published = await prepareSkillPublication({
      submissionFiles: [{ bytes: fixture.outer }],
      catalog: EMPTY_CATALOG,
      repository: "wchao6891/PromptDirector-Curated",
      reviewedAt: "2026-08-23T08:30:00.000Z"
    });
    const repeated = await prepareSkillPublication({
      submissionFiles: [{ bytes: fixture.outer }],
      catalog: published.catalog,
      repository: "wchao6891/PromptDirector-Curated",
      reviewedAt: "2026-08-25T08:30:00.000Z"
    });

    assert.equal(repeated.status, "existing");
    assert.equal(repeated.item.id, "composition-method@1.0.0");
    assert.deepEqual(repeated.catalog, published.catalog);
    assert.equal(repeated.release.tag, "skill-composition-method-v1.0.0");
  } finally { await fixture.cleanup(); }
});

test("unsafe existing semantic-version numbers are rejected instead of rounded", async () => {
  const first = await makeFixture();
  const changed = await makeFixture({ body: "Changed content." });
  try {
    const published = await prepareSkillPublication({
      submissionFiles: [{ bytes: first.outer }],
      catalog: EMPTY_CATALOG,
      repository: "wchao6891/PromptDirector-Curated",
      reviewedAt: "2026-08-23T08:30:00.000Z"
    });
    const unsafeVersion = "9007199254740993.0.0";
    const unsafeCatalog = {
      ...published.catalog,
      skills: [{ ...published.item, id: `composition-method@${unsafeVersion}`, version: unsafeVersion }]
    };
    await assert.rejects(
      () => prepareSkillPublication({
        submissionFiles: [{ bytes: changed.outer }],
        catalog: unsafeCatalog,
        repository: "wchao6891/PromptDirector-Curated",
        reviewedAt: "2026-08-24T08:30:00.000Z"
      }),
      /安全范围/
    );
  } finally {
    await first.cleanup();
    await changed.cleanup();
  }
});

test("a later version cannot silently replace the stable public author", async () => {
  const first = await makeFixture();
  const takeover = await makeFixture({ body: "Changed content.", author: "Another Creator" });
  try {
    const published = await prepareSkillPublication({
      submissionFiles: [{ bytes: first.outer }],
      catalog: EMPTY_CATALOG,
      repository: "wchao6891/PromptDirector-Curated",
      reviewedAt: "2026-08-23T08:30:00.000Z"
    });
    await assert.rejects(
      () => prepareSkillPublication({
        submissionFiles: [{ bytes: takeover.outer }],
        catalog: published.catalog,
        repository: "wchao6891/PromptDirector-Curated",
        reviewedAt: "2026-08-24T08:30:00.000Z"
      }),
      /公开署名不一致/
    );
  } finally {
    await first.cleanup();
    await takeover.cleanup();
  }
});

test("repository owner approval is serialized, publishes immutable assets, deploys Pages, then closes", async () => {
  const [approval, preflight, pages] = await Promise.all([
    readFile(new URL("../.github/workflows/approve-skill-submission.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/skill-submission-preflight.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8")
  ]);

  assert.match(approval, /issues:\s*\n\s+types: \[labeled\]/);
  assert.match(approval, /github\.event\.label\.name == '批准发布'/);
  assert.match(approval, /github\.actor == github\.repository_owner/);
  assert.match(approval, /group: curated-skill-publication/);
  assert.match(approval, /cancel-in-progress: false/);
  assert.match(approval, /permissions: \{\}/);
  assert.match(approval, /publish:\s*\n\s+if:[\s\S]*?permissions:\s*\n\s+contents: write/);
  assert.match(approval, /contents: write/);
  assert.match(approval, /issues: write/);
  assert.match(approval, /pages: write/);
  assert.match(approval, /id-token: write/);
  assert.match(approval, /tools\/approve-skill-submission\.mjs/);
  assert.match(approval, /actions\/checkout@v6/);
  assert.match(approval, /actions\/github-script@v8/);
  assert.doesNotMatch(approval, /actions\/(?:checkout@v4|github-script@v7)/);
  assert.match(approval, /gh release download/);
  assert.match(approval, /gh release create/);
  assert.match(approval, /gh release upload/);
  assert.match(approval, /sha256sum --check/);
  assert.match(approval, /uses: \.\/\.github\/workflows\/pages\.yml/);
  assert.match(approval, /complete:\s*\n\s+needs: \[publish, deploy\]/);
  assert.match(approval, /labels: \['published'\]/);
  assert.match(approval, /state: 'closed'/);
  assert.equal((approval.match(/state: 'closed'/g) ?? []).length, 1, "only the success job may close the issue");
  assert.doesNotMatch(preflight, /types: \[[^\]]*labeled/);
  assert.match(pages, /workflow_call:/);
  assert.match(pages, /ref: main/);
});

async function makeFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "promptdirector-skill-approval-"));
  const payloadRoot = join(root, "payload");
  const outerRoot = join(root, "outer");
  await mkdir(payloadRoot, { recursive: true });
  await mkdir(outerRoot, { recursive: true });
  const skillText = `---\nname: composition-method\ndescription: Compose clearly.\n---\n\n# Method\n\n${options.body ?? "Use depth."}\n`;
  await writeFile(join(payloadRoot, "SKILL.md"), skillText);
  const payloadPath = join(root, "payload.zip");
  await writePromptDirectorZip(payloadPath, payloadRoot, ["SKILL.md"]);
  const payload = new Uint8Array(await readFile(payloadPath));
  const manifest = {
    format: "prompt-director-curated-skill-submission",
    version: 1,
    skillId: "composition-method",
    callName: options.callName ?? "composition-method",
    title: "构图方法",
    author: options.author ?? "Creator One",
    license: "CC BY 4.0",
    reviewStatus: "pending",
    summary: "可复用的构图方法。",
    digest: hash(Buffer.from(`SKILL.md\0${skillText}\0`)),
    fileCount: 1,
    payloadSha256: hash(payload),
    payloadBytes: payload.byteLength,
    createdAt: "2026-08-23T00:00:00.000Z"
  };
  await writeFile(join(outerRoot, "submission.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(outerRoot, "payload.zip"), payload);
  const outerPath = join(root, "submission.zip");
  await writePromptDirectorZip(outerPath, outerRoot, ["submission.json", "payload.zip"]);
  return { outer: new Uint8Array(await readFile(outerPath)), payload, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
