import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeSiteSkillCatalog } from "../tools/curated-skill-site-data.mjs";

const item = {
  id: "composition-method@1.0.0",
  skillId: "composition-method",
  version: "1.0.0",
  title: "Composition Method",
  callName: "构图方法",
  authorId: "creator-one",
  author: "Creator One",
  license: "CC BY 4.0",
  reviewStatus: "approved",
  reviewedAt: "2026-08-23T00:00:00.000Z",
  summary: "A reusable composition method.",
  downloadUrl: "https://github.com/wchao6891/PromptDirector-Curated/releases/download/skills/composition-method.zip",
  sha256: "a".repeat(64),
  archiveBytes: 100,
  order: 1
};

test("public Skill catalog enforces stable identity, version, author, license, review and summary", () => {
  const catalog = normalizeSiteSkillCatalog({ format: "prompt-director-curated-skills", version: 1, updatedAt: "2026-08-23T00:00:00.000Z", skills: [item] });
  assert.equal(catalog.skills[0].skillId, "composition-method");
  assert.equal(catalog.skills[0].callName, "构图方法");
  assert.throws(() => normalizeSiteSkillCatalog({ ...catalog, skills: [{ ...item, reviewStatus: "pending" }] }), /审核|发布/);
  assert.throws(() => normalizeSiteSkillCatalog({ ...catalog, skills: [{ ...item, id: "reviewer-invented-id" }] }), /编号|发布/);
  assert.throws(() => normalizeSiteSkillCatalog({ ...catalog, skills: [{ ...item, license: "MIT" }] }), /许可|发布/);
  for (const callName of ["", "bad/name", "bad\\name", "bad\u0000name", "名".repeat(81)]) {
    assert.throws(() => normalizeSiteSkillCatalog({ ...catalog, skills: [{ ...item, callName }] }), /调用名|发布/);
  }
});

test("public site provides an independent browse-and-download-only Skill page", async () => {
  const [casesHtml, skillsHtml, app, catalog] = await Promise.all([
    readFile(new URL("../site/index.html", import.meta.url), "utf8"),
    readFile(new URL("../site/skills.html", import.meta.url), "utf8"),
    readFile(new URL("../site/skills.js", import.meta.url), "utf8"),
    readFile(new URL("../site/skills-catalog.json", import.meta.url), "utf8")
  ]);
  assert.match(casesHtml, /href="skills\.html">精选 Skill</);
  assert.match(skillsHtml, /href="index\.html">精选案例</);
  assert.match(skillsHtml, /aria-current="page"[^>]*>精选 Skill</);
  assert.match(app, /fetch\("skills-catalog\.json"/);
  assert.match(app, /download\.href = item\.downloadUrl/);
  assert.doesNotMatch(app, /chrome\.|保存到本地|安装 Skill|eval\(|new Function|innerHTML/);
  assert.deepEqual(JSON.parse(catalog), { format: "prompt-director-curated-skills", version: 1, updatedAt: "2026-08-23T00:00:00.000Z", skills: [] });
});
