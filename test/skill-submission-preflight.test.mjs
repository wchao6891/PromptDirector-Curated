import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writePromptDirectorZip } from "../tools/curated-zip.mjs";
import { preflightSkillSubmission } from "../tools/skill-submission-preflight.mjs";

test("unpublished Skill submission passes without review-assigned author ID or semantic version", async () => {
  const fixture = await makeFixture();
  try {
    const result = await preflightSkillSubmission([{ name: "skill-submission.zip", bytes: fixture.outer }]);
    assert.equal(result.ok, true);
    assert.equal(result.skillId, "composition-method");
    assert.equal(result.author, "Creator One");
    assert.equal(result.license, "CC BY 4.0");
    assert.equal("version" in result, false);
    assert.equal("authorId" in result, false);
    assert.equal(result.fileCount, 2);
  } finally { await fixture.cleanup(); }
});

test("unpublished Skill submission uses the fixed CC BY 4.0 license", async () => {
  const fixture = await makeFixture({ license: "MIT" });
  try {
    await assert.rejects(
      () => preflightSkillSubmission([{ name: "skill-submission.zip", bytes: fixture.outer }]),
      /CC BY 4\.0/
    );
  } finally { await fixture.cleanup(); }
});

test("unpublished Skill submission cannot claim review-assigned identifiers or version", async () => {
  for (const manifest of [
    { authorId: "creator-one" },
    { skillVersion: "1.0.0" },
    { catalogId: "composition-method@1.0.0" }
  ]) {
    const fixture = await makeFixture({ manifest });
    try {
      await assert.rejects(
        () => preflightSkillSubmission([{ name: "skill-submission.zip", bytes: fixture.outer }]),
        /人工审核发布阶段/
      );
    } finally { await fixture.cleanup(); }
  }
});

test("scripts, undeclared files and private-looking text are rejected", async () => {
  for (const variant of [
    { extraPath: "scripts/run.sh", extraText: "echo no" },
    { extraPath: "notes.txt", extraText: "undeclared" },
    { skillText: "# Method\n\nAPI_KEY=secret-value-123456" }
  ]) {
    const fixture = await makeFixture(variant);
    try {
      await assert.rejects(() => preflightSkillSubmission([{ name: "skill-submission.zip", bytes: fixture.outer }]), /不允许|隐私风险/);
    } finally { await fixture.cleanup(); }
  }
});

test("Skill issue template and workflow remain human-reviewed and never auto-publish", async () => {
  const [form, workflow] = await Promise.all([
    readFile(new URL("../.github/ISSUE_TEMPLATE/curated-skill-submission.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/skill-submission-preflight.yml", import.meta.url), "utf8")
  ]);
  assert.match(form, /人工审核/);
  assert.match(form, /提交不代表一定入选/);
  assert.match(form, /CC BY 4\.0/);
  assert.doesNotMatch(form, /作者 ID|语义版本/);
  assert.match(workflow, /tools\/skill-submission-preflight\.mjs/);
  assert.doesNotMatch(workflow, /report\.version|report\.authorId/);
  assert.doesNotMatch(workflow, /git push|upload-pages|releases\.create|createRelease/);
});

async function makeFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "promptdirector-skill-preflight-"));
  const payloadRoot = join(root, "payload");
  const outerRoot = join(root, "outer");
  await mkdir(join(payloadRoot, "references"), { recursive: true });
  await mkdir(outerRoot, { recursive: true });
  const skillText = `---\nname: composition-method\ndescription: Compose clearly.\n---\n\n${options.skillText ?? "# Method\n\nUse depth."}\n`;
  const guideText = "# Guide\n\nKeep the subject readable.\n";
  await writeFile(join(payloadRoot, "SKILL.md"), skillText);
  await writeFile(join(payloadRoot, "references", "guide.md"), guideText);
  const paths = ["SKILL.md", "references/guide.md"];
  const texts = new Map([["SKILL.md", skillText], ["references/guide.md", guideText]]);
  if (options.extraPath) {
    await mkdir(join(payloadRoot, options.extraPath.split("/").slice(0, -1).join("/")), { recursive: true });
    await writeFile(join(payloadRoot, options.extraPath), options.extraText);
    paths.push(options.extraPath);
    texts.set(options.extraPath, options.extraText);
  }
  const payloadPath = join(root, "payload.zip");
  await writePromptDirectorZip(payloadPath, payloadRoot, paths);
  const payload = new Uint8Array(await readFile(payloadPath));
  const payloadSha256 = hash(payload);
  const manifest = {
    format: "prompt-director-curated-skill-submission",
    version: 1,
    skillId: "composition-method",
    callName: "composition-method",
    title: "Composition Method",
    author: "Creator One",
    license: options.license ?? "CC BY 4.0",
    reviewStatus: "pending",
    summary: "A reusable composition method.",
    digest: hash(Buffer.from(paths.map((path) => `${path}\0${String(texts.get(path))}\0`).join(""))),
    fileCount: paths.length,
    payloadSha256,
    payloadBytes: payload.byteLength,
    createdAt: "2026-08-23T00:00:00.000Z",
    ...options.manifest
  };
  await writeFile(join(outerRoot, "submission.json"), `${JSON.stringify(manifest)}\n`);
  await writeFile(join(outerRoot, "payload.zip"), payload);
  const outerPath = join(root, "submission.zip");
  await writePromptDirectorZip(outerPath, outerRoot, ["submission.json", "payload.zip"]);
  return { outer: new Uint8Array(await readFile(outerPath)), cleanup: () => rm(root, { recursive: true, force: true }) };
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
