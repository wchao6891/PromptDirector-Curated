import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, cp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createReviewDesk } from '../tools/review-desk/server.mjs';
import { importPackage, preparePackage, reviewSelection, sanitizeLibrary, suggestedAuthor } from '../tools/review-desk/package.mjs';
import { mergeCatalog, prepareSitePreview, publishPrepared } from '../tools/review-desk/publish.mjs';
import { writePromptDirectorZip } from '../tools/curated-zip.mjs';
import { readStoredZip } from '../tools/submission-preflight.mjs';
import { run, save, json, fileDigest } from '../tools/review-desk/common.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const policy = await json(join(repoRoot, 'submission-policy.json'));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'curated-review-test-'));
  const source = join(root, 'source');
  await mkdir(join(source, 'images'), { recursive: true });
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', join(source, 'images/a.png')]);
  const entry = { id: 'test-entry', title: '测试图片', text: '<script>测试提示词，仅作为文字</script>', primaryMediaId: 'image-a',
    url: 'https://example.com/art', sourcePages: [{ title: '测试来源', url: 'https://example.com/art' }],
    note: 'PRIVATE-NOTE', customLabels: ['PRIVATE-TAG'], metadataLabels: ['作者：测试作者', '私有标签'],
    mediaAssets: [{ id: 'image-a', kind: 'image', usage: 'content', storageMode: 'managed', mimeType: 'image/png', assetPath: 'images/a.png', width: 32, height: 32, sourceAuthor: '测试作者', sourceTitle: '测试作者 · 2026-09-13', localPath: '/private/not-for-public' }] };
  const library = { format: 'prompt-case-library', version: 5, entries: [entry], composerSessions: ['PRIVATE-CHAT'], taxonomy: { nodes: [{ id: 'personal', name: 'PRIVATE-CATEGORY' }] } };
  await save(join(source, 'library.json'), library);
  const archive = join(root, 'input.zip');
  await writePromptDirectorZip(archive, source, ['library.json', 'images/a.png']);
  return { root, archive, library, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function selection() {
  return { title: '自动测试合集', publisher: '测试编辑', summary: '明确标注的测试内容', evidence: '自动测试夹具，不公开发布', rightsStatus: 'source_unverified', confirmed: true, coverId: 'test-entry', previewMaxEdge: 1200, entries: [{ id: 'test-entry', author: '测试作者', sourceUrl: 'https://example.com/art' }] };
}

test('普通完整 ZIP 保留原始媒体，剔除私人字段，预览使用实际网站校验', async () => {
  const f = await fixture();
  try {
    const imported = await importPackage([f.archive], f.root, policy);
    assert.equal(imported.cleaned, true);
    assert.equal(imported.library.version, 5);
    assert.doesNotMatch(JSON.stringify(imported.library), /PRIVATE-|localPath|composerSessions/);
    assert.equal(suggestedAuthor(f.library.entries[0]), '测试作者');
    const prepared = await preparePackage({ root: f.root, selection: selection(), repository: 'wchao6891/PromptDirector-Curated', siteUrl: 'https://wchao6891.github.io/PromptDirector-Curated/', reviewerId: 'github-123', policy });
    const zip = readStoredZip(await readFile(prepared.assets[0].path), { maxBytes: policy.maxSubmissionBytes, maxFiles: policy.maxFileCount, maxFileBytes: policy.maxSubmissionBytes });
    assert.deepEqual(Buffer.from(zip.get('images/a.png')), await readFile(join(f.root, 'source/images/a.png')));
    assert.equal(prepared.theme.caseCount, 1);
    assert.equal(prepared.theme.rightsStatus, 'source_unverified');
    const checkout = await prepareSitePreview(prepared, repoRoot);
    const catalog = await json(join(checkout, 'site/public-catalog.json'));
    assert.equal(catalog.themes.find(theme => theme.id === prepared.theme.id).sha256, await fileDigest(prepared.assets[0].path));
    assert.equal(mergeCatalog(catalog, prepared.theme).themes.length, catalog.themes.length);
    assert.throws(() => mergeCatalog(catalog, { ...prepared.theme, sha256: '0'.repeat(64) }), /停止覆盖/);
  } finally { await f.cleanup(); }
});

test('预览允许先检查效果，但选择必须具备原作者、来源和收录封面', async () => {
  const f = await fixture();
  try {
    const library = sanitizeLibrary(f.library);
    assert.equal(reviewSelection(library, { ...selection(), confirmed: false }).length, 1);
    assert.throws(() => reviewSelection(library, { ...selection(), coverId: 'missing' }), /封面/);
    assert.throws(() => reviewSelection(library, { ...selection(), entries: [{ id: 'test-entry', author: '', sourceUrl: 'https://example.com/art' }] }), /原作者/);
    assert.throws(() => reviewSelection(library, { ...selection(), entries: [{ id: 'test-entry', author: '作者', sourceUrl: 'javascript:alert(1)' }] }), /来源/);
  } finally { await f.cleanup(); }
});

test('视频包使用真实 H.264 检查，下载包和网站视频保留同一原始文件', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'source');
    await mkdir(join(source, 'videos'));
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=32x32:r=2', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(source, 'videos/a.mp4')]);
    await copyFile(join(source, 'images/a.png'), join(source, 'images/poster.png'));
    const library = { ...f.library, entries: [{ ...f.library.entries[0], primaryMediaId: 'video-a', mediaAssets: [
      { id: 'video-a', kind: 'video', usage: 'content', storageMode: 'managed', mimeType: 'video/mp4', assetPath: 'videos/a.mp4', posterAssetId: 'poster-a' },
      { id: 'poster-a', kind: 'image', usage: 'poster', storageMode: 'managed', mimeType: 'image/png', assetPath: 'images/poster.png', derivedFromAssetId: 'video-a', width: 32, height: 32 }
    ] }] };
    await save(join(source, 'library.json'), library);
    await writePromptDirectorZip(f.archive, source, ['library.json', 'videos/a.mp4', 'images/poster.png']);
    await importPackage([f.archive], f.root, policy);
    const prepared = await preparePackage({ root: f.root, selection: selection(), repository: 'wchao6891/PromptDirector-Curated', siteUrl: 'https://wchao6891.github.io/PromptDirector-Curated/', reviewerId: 'github-123', policy });
    const hash = await fileDigest(join(source, 'videos/a.mp4'));
    assert.equal(prepared.theme.videoCount, 1);
    assert.equal(prepared.assets[1].sha256, hash);
    const zip = readStoredZip(await readFile(prepared.assets[0].path), { maxBytes: policy.maxSubmissionBytes, maxFiles: 4, maxFileBytes: policy.maxSubmissionBytes });
    assert.deepEqual(Buffer.from(zip.get('videos/a.mp4')), await readFile(join(source, 'videos/a.mp4')));
    const preview = await json(join(prepared.siteRoot, `previews/${prepared.theme.packageId}/preview.json`));
    assert.equal(preview.entries[0].videoSha256, hash);
  } finally { await f.cleanup(); }
});

test('本机审核接口拒绝跨站及无凭据写入，支持审核进度保存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curated-desk-http-'));
  const desk = await createReviewDesk({ dataRoot: root, repoRoot });
  try {
    let response = await fetch(desk.origin + '/api/sessions', { method: 'POST', body: '{}' });
    assert.equal(response.status, 403);
    response = await fetch(desk.origin + '/api/sessions', { method: 'POST', headers: { 'x-review-token': desk.token, Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(response.status, 403);
    response = await fetch(desk.origin + '/api/sessions', { method: 'POST', headers: { 'x-review-token': desk.token }, body: JSON.stringify({ title: '<script>literal</script>' }) });
    const { id } = await response.json(); assert.ok(id);
    const selected = selection();
    response = await fetch(`${desk.origin}/api/sessions/${id}/selection`, { method: 'POST', headers: { 'x-review-token': desk.token }, body: JSON.stringify(selected) });
    assert.equal(response.status, 200);
    assert.deepEqual(await json(join(root, id, 'selection.json')), selected);
    response = await fetch(`${desk.origin}/api/sessions/${id}/publish`, { method: 'POST', headers: { 'x-review-token': desk.token }, body: '{}' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /确认/);
  } finally { await new Promise(resolve => desk.server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});

test('发布链路的远程替身验证：只在文件摘要与线上目录一致后成功；重复执行复用附件', async () => {
  const f = await fixture();
  try {
    await importPackage([f.archive], f.root, policy);
    const prepared = await preparePackage({ root: f.root, selection: selection(), repository: 'wchao6891/PromptDirector-Curated', siteUrl: 'https://wchao6891.github.io/PromptDirector-Curated/', reviewerId: 'github-123', policy });
    const checkout = join(prepared.buildRoot, 'publication-checkout');
    await mkdir(join(checkout, '.git'), { recursive: true });
    await cp(join(repoRoot, 'site'), join(checkout, 'site'), { recursive: true });
    await cp(join(repoRoot, 'tools'), join(checkout, 'tools'), { recursive: true });
    const calls = [], release = { draft: false, html_url: 'https://github.com/test/release', assets: await Promise.all(prepared.assets.map(async asset => ({ name: asset.name, digest: `sha256:${asset.sha256}`, size: (await stat(asset.path)).size, download_count: 7 }))) };
    const execute = async (command, args, options) => {
      calls.push([command, ...args]);
      if (command === process.execPath) return run(command, args, options);
      if (command === 'gh' && args[0] === 'api') {
        if (args[1] === 'user') return JSON.stringify({ id: 123, login: 'test-publisher' });
        if (args[1].includes('/releases/tags/')) return JSON.stringify(release);
        return JSON.stringify({ permissions: { push: true }, default_branch: 'main' });
      }
      if (command === 'git' && args.includes('rev-parse')) return 'test-commit';
      return '';
    };
    const fetchImpl = async url => new Response(JSON.stringify(String(url).includes('public-catalog') ? { themes: [prepared.theme] } : { entries: [{}] }));
    const result = await publishPrepared(f.root, () => {}, { execute, fetchImpl });
    assert.equal(result.completed, true);
    assert.equal(calls.some(call => call.includes('upload')), false);
    assert.equal((await json(join(checkout, 'site/metrics.json'))).downloads[prepared.theme.id], 7);
    release.assets[0].digest = 'sha256:' + '0'.repeat(64);
    await assert.rejects(publishPrepared(f.root, () => {}, { execute, fetchImpl }), /未覆盖/);
    const failure = await json(join(f.root, 'publication.json'));
    assert.equal(failure.completed, false); assert.equal(failure.phase, 'release');
    assert.equal(calls.some(call => call.includes('--clobber')), false);
  } finally { await f.cleanup(); }
});
