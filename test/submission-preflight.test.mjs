import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writePromptDirectorZip } from "../tools/curated-zip.mjs";
import {
  extractOfficialAttachmentUrls,
  downloadAttachment,
  fetchOfficialAttachment,
  isOfficialAttachmentUrl,
  preflightSubmission,
  readStoredZip,
  submissionTransportLimits
} from "../tools/submission-preflight.mjs";

const POLICY = {
  maxSubmissionBytes: 128 * 1024 * 1024,
  maxTransportFileBytes: 24 * 1024 * 1024,
  transportOverheadBytes: 16 * 1024,
  maxFileCount: 4096,
  maxLibraryJsonBytes: 16 * 1024 * 1024,
  maxEntries: 5000,
  maxImageBytes: 16 * 1024 * 1024,
  maxVideoBytes: 128 * 1024 * 1024,
  maxImagePixels: 40_000_000
};

test("真实配置支持 46 卷，数量随总容量推导而非单独限制", async () => {
  const policy = JSON.parse(await readFile(new URL("../submission-policy.json", import.meta.url), "utf8"));
  assert.equal(policy.maxSubmissionBytes, 2 * 1024 ** 3 - 1);
  assert.ok(submissionTransportLimits(policy).maxFiles >= 46);
  const fixture = await makeSubmissionFixture();
  try {
    const parts = await makeParts(fixture.root, fixture.outer, fixture.submissionId, 46);
    const result = await preflightSubmission(parts.reverse(), { policy, skipMediaProbe: true });
    assert.equal(result.partCount, 46);
    assert.deepEqual(result.payload, fixture.payload);
    await assert.rejects(preflightSubmission(parts.slice(1), { policy, skipMediaProbe: true }), /不完整/);
  } finally { await fixture.cleanup(); }
});

test("附件实际字节超限时停止读取，不依赖 Content-Length", async () => {
  await assert.rejects(downloadAttachment("https://github.com/user-attachments/files/1/a.zip", {
    maxTransportFileBytes: 2
  }, { fetchImpl: async () => new Response(new Uint8Array([1, 2, 3])) }), /超过上传上限/);
});

test("GitHub 网络失败归为审核系统异常，不能要求用户重新生成附件", async () => {
  await assert.rejects(fetchOfficialAttachment('https://github.com/user-attachments/files/1/a.zip', {
    fetchImpl: async () => { throw new TypeError('fetch failed'); }
  }), error => error.errorType === 'system');
});

test("下载前失败也会写出具体预检报告", async () => {
  const root = await mkdtemp(join(tmpdir(), "preflight-report-test-"));
  try {
    const body = join(root, "issue.md");
    const report = join(root, "report.json");
    await writeFile(body, "没有附件");
    const result = spawnSync(process.execPath, [new URL("../tools/submission-preflight.mjs", import.meta.url).pathname,
      "--issue-body", body, "--report", report], { encoding: "utf8" });
    assert.equal(result.status, 1);
    const data = JSON.parse(await readFile(report, "utf8"));
    assert.equal(data.ok, false);
    assert.match(data.message, /没有找到 GitHub 官方投稿附件/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("当前导出版本与公开来源格式字段可审查，大原图不受独立小容量限制", async () => {
  const fixture = await makeSubmissionFixture({}, { version: 5, imageBytes: 32 * 1024 * 1024 });
  try {
    const policy = JSON.parse(await readFile(new URL('../submission-policy.json', import.meta.url), 'utf8'));
    const parts = await makeParts(fixture.root, fixture.outer, fixture.submissionId, 2);
    const result = await preflightSubmission(parts, { policy, skipMediaProbe: true });
    assert.equal(result.caseCount, 1);
    assert.ok(result.payload.byteLength > 32 * 1024 * 1024);
  } finally { await fixture.cleanup(); }
});

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

test("附件下载只允许逐跳跳转到 GitHub 官方文件域名", async () => {
  const calls = [];
  const responses = [
    new Response(null, {
      status: 302,
      headers: { location: "https://objects.githubusercontent.com/github-production-repository-file/123/submission.zip" }
    }),
    new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  ];
  const response = await fetchOfficialAttachment(
    "https://github.com/user-attachments/files/123/submission.zip",
    { fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    } }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.url), [
    "https://github.com/user-attachments/files/123/submission.zip",
    "https://objects.githubusercontent.com/github-production-repository-file/123/submission.zip"
  ]);
  assert.equal(calls.every((call) => call.options.redirect === "manual"), true);
  assert.equal(calls.every((call) => call.options.credentials === "omit"), true);
});

test("附件下载在离开 GitHub 官方域名前立即拒绝", async () => {
  let calls = 0;
  await assert.rejects(
    fetchOfficialAttachment(
      "https://github.com/user-attachments/files/123/submission.zip",
      { fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "https://example.com/submission.zip" } });
      } }
    ),
    /跳转.*GitHub 官方地址/
  );
  assert.equal(calls, 1);
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
  assert.match(workflow, /apt-get install --yes --no-install-recommends ffmpeg/);
  assert.match(workflow, /投稿文件无需重新上传/);
});

async function makeSubmissionFixture(entryPatch = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "promptdirector-preflight-test-"));
  const payloadRoot = join(root, "payload");
  const outerRoot = join(root, "outer");
  await mkdir(join(payloadRoot, "images", "case-1"), { recursive: true });
  await mkdir(outerRoot, { recursive: true });
  const imagePath = "images/case-1/media-1.png";
  const image = new Uint8Array(options.imageBytes || 12);
  image.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const library = {
    format: "prompt-case-library",
    version: options.version || 3,
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
        playbackCapability: "unknown",
        sourceAuthor: '测试作者', originalWorkUrl: 'https://example.com/source', sourceFormat: 'png', formatCategory: 'image'
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
  const outputs = [];
  for (let index = 0; index < count; index += 1) {
    const payload = outer.slice(Math.floor(index * outer.byteLength / count), Math.floor((index + 1) * outer.byteLength / count));
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
