import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writePromptDirectorZip } from "../tools/curated-zip.mjs";
import {
  extractOfficialAttachmentUrls,
  isOfficialAttachmentUrl,
  preflightSubmission,
  readStoredZip
} from "../tools/submission-preflight.mjs";

const POLICY = {
  maxSubmissionBytes: 128 * 1024 * 1024,
  maxTransportFileBytes: 24 * 1024 * 1024,
  maxTransportFiles: 6,
  maxFileCount: 4096,
  maxLibraryJsonBytes: 16 * 1024 * 1024,
  maxEntries: 5000,
  maxImageBytes: 16 * 1024 * 1024,
  maxVideoBytes: 128 * 1024 * 1024,
  maxImagePixels: 40_000_000
};

test("完整投稿包通过并以 payload 摘要作为 submissionId", async () => {
  const fixture = await makeSubmissionFixture();
  try {
    const result = await preflightSubmission([{ name: "submission.zip", bytes: fixture.outer }], {
      policy: POLICY,
      skipMediaProbe: true
    });
    assert.equal(result.ok, true);
    assert.equal(result.submissionId, fixture.submissionId);
    assert.equal(result.caseCount, 1);
    assert.equal(result.mediaCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("分卷可乱序重组，缺卷、重复卷和篡改都会拒绝", async () => {
  const fixture = await makeSubmissionFixture();
  try {
    const parts = await makeParts(fixture.root, fixture.outer, fixture.submissionId, 2);
    const accepted = await preflightSubmission([parts[1], parts[0]], { policy: POLICY, skipMediaProbe: true });
    assert.equal(accepted.submissionId, fixture.submissionId);
    await assert.rejects(
      preflightSubmission([parts[0]], { policy: POLICY, skipMediaProbe: true }),
      /不完整/
    );
    await assert.rejects(
      preflightSubmission([parts[0], parts[0]], { policy: POLICY, skipMediaProbe: true }),
      /重复分卷/
    );
    const changed = { ...parts[1], bytes: parts[1].bytes.slice() };
    changed.bytes[80] ^= 1;
    await assert.rejects(
      preflightSubmission([parts[0], changed], { policy: POLICY, skipMediaProbe: true }),
      /校验|损坏|修改/
    );
  } finally {
    await fixture.cleanup();
  }
});

test("ZIP 路径穿越会被拒绝", async () => {
  const fixture = await makeSubmissionFixture();
  try {
    const changed = fixture.outer.slice();
    replaceAscii(changed, "payload.zip", "../evil.zip");
    assert.throws(() => readStoredZip(changed, {
      maxBytes: POLICY.maxSubmissionBytes,
      maxFiles: 2,
      maxFileBytes: POLICY.maxSubmissionBytes
    }), /不安全路径/);
  } finally {
    await fixture.cleanup();
  }
});

test("只提取 GitHub 官方投稿附件", () => {
  const official = "https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc";
  const body = `${official}\nhttps://example.com/evil.zip`;
  assert.deepEqual(extractOfficialAttachmentUrls(body), [official]);
  assert.equal(isOfficialAttachmentUrl(official), true);
  assert.equal(isOfficialAttachmentUrl("https://github.com/example/file.zip"), false);
  assert.equal(isOfficialAttachmentUrl("https://example.com/user-attachments/assets/a"), false);
});

test("即使 ZIP 和摘要有效，额外私人字段仍会被拒绝", async () => {
  const fixture = await makeSubmissionFixture({ note: "私人笔记" });
  try {
    await assert.rejects(
      preflightSubmission([{ name: "submission.zip", bytes: fixture.outer }], {
        policy: POLICY,
        skipMediaProbe: true
      }),
      /未公开字段/
    );
  } finally {
    await fixture.cleanup();
  }
});

test("投稿表单区分第三方推荐与本人授权，预检不会因标签缺失而跳过", async () => {
  const [form, workflow] = await Promise.all([
    readFile(new URL("../.github/ISSUE_TEMPLATE/curated-submission.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/submission-preflight.yml", import.meta.url), "utf8")
  ]);
  assert.match(form, /第三方公开案例推荐（不声明授权，权利归原作者）/);
  assert.match(form, /我不代表原作者授予许可/);
  assert.match(form, /可核验的原作者与来源/);
  assert.match(workflow, /types: \[opened, edited, reopened, labeled\]/);
  assert.match(workflow, /startsWith\(github\.event\.issue\.title, '\[投稿\]'\)/);
});

async function makeSubmissionFixture(entryPatch = {}) {
  const root = await mkdtemp(join(tmpdir(), "promptdirector-preflight-test-"));
  const payloadRoot = join(root, "payload");
  const outerRoot = join(root, "outer");
  await mkdir(join(payloadRoot, "images", "case-1"), { recursive: true });
  await mkdir(outerRoot, { recursive: true });
  const imagePath = "images/case-1/media-1.png";
  const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const library = {
    format: "prompt-case-library",
    version: 3,
    entries: [{
      id: "case-1",
      title: "竖图案例",
      text: "公开提示词",
      url: "https://example.com/source",
      sourcePages: [{ title: "来源", url: "https://example.com/source" }],
      classification: { pathIds: ["content:prompt:image"], status: "confirmed", source: "manual" },
      facetAssignments: [],
      customLabels: [],
      metadataLabels: ["作者：测试作者", "权利：本人原创"],
      primaryMediaId: "media-1",
      timeNotes: [],
      mediaPrompts: [],
      visualSetAnalyses: [],
      videoAnalyses: [],
      mediaAssets: [{
        id: "media-1",
        kind: "image",
        usage: "content",
        storageMode: "managed",
        assetPath: imagePath,
        reviewStatus: "unverified",
        playbackCapability: "unknown"
      }],
      ...entryPatch
    }]
  };
  await writeFile(join(payloadRoot, "library.json"), `${JSON.stringify(library)}\n`);
  await writeFile(join(payloadRoot, imagePath), image);
  const payloadPath = join(root, "payload.zip");
  await writePromptDirectorZip(payloadPath, payloadRoot, ["library.json", imagePath]);
  const payload = new Uint8Array(await readFile(payloadPath));
  const submissionId = hash(payload);
  await writeFile(join(outerRoot, "submission.json"), `${JSON.stringify({
    format: "prompt-director-curated-submission",
    version: 1,
    submissionId,
    payloadBytes: payload.byteLength,
    caseCount: 1,
    mediaCount: 1,
    createdAt: new Date().toISOString()
  })}\n`);
  await writeFile(join(outerRoot, "payload.zip"), payload);
  const outerPath = join(root, "submission.zip");
  await writePromptDirectorZip(outerPath, outerRoot, ["submission.json", "payload.zip"]);
  return {
    root,
    payload,
    submissionId,
    outer: new Uint8Array(await readFile(outerPath)),
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

async function makeParts(root, outer, submissionId, count) {
  const archiveSha256 = hash(outer);
  const size = Math.ceil(outer.byteLength / count);
  const outputs = [];
  for (let index = 0; index < count; index += 1) {
    const payload = outer.slice(index * size, Math.min(outer.byteLength, (index + 1) * size));
    const partRoot = join(root, `part-${index + 1}`);
    await mkdir(partRoot, { recursive: true });
    await writeFile(join(partRoot, "part.json"), `${JSON.stringify({
      format: "prompt-director-curated-submission-part",
      version: 1,
      submissionId,
      archiveSha256,
      archiveBytes: outer.byteLength,
      partIndex: index + 1,
      partCount: count,
      payloadSha256: hash(payload),
      payloadBytes: payload.byteLength
    })}\n`);
    await writeFile(join(partRoot, "payload.bin"), payload);
    const outputPath = join(root, `part-${index + 1}.zip`);
    await writePromptDirectorZip(outputPath, partRoot, ["part.json", "payload.bin"]);
    outputs.push({ name: `part-${index + 1}.zip`, bytes: new Uint8Array(await readFile(outputPath)) });
  }
  return outputs;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceAscii(bytes, before, after) {
  assert.equal(before.length, after.length);
  const source = Buffer.from(before);
  const replacement = Buffer.from(after);
  let replacements = 0;
  for (let index = 0; index <= bytes.length - source.length; index += 1) {
    if (source.every((value, offset) => bytes[index + offset] === value)) {
      bytes.set(replacement, index);
      replacements += 1;
    }
  }
  assert.equal(replacements, 2);
}
