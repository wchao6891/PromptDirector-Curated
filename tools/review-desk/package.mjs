import { readFile, mkdir, writeFile, stat, copyFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { preflightSubmission, readStoredZip, inspectPayload, SUPPORTED_CURATED_LIBRARY_VERSIONS } from '../submission-preflight.mjs';
import { writePromptDirectorZip } from '../curated-zip.mjs';
import { normalizeSitePreview, normalizeSiteRightsReview, normalizeTheme } from '../curated-site-data.mjs';
import { digest, fileDigest, json, save, run, httpsUrl } from './common.mjs';

const emptyPersonal = ['facetAssignments', 'customLabels', 'timeNotes', 'mediaPrompts', 'visualSetAnalyses', 'videoAnalyses'];
const assetKeys = ['id', 'kind', 'usage', 'storageMode', 'sourceUrl', 'sourceTitle', 'sourceAuthor', 'originalWorkUrl', 'sourceFormat', 'formatCategory', 'capturedAt', 'mimeType', 'width', 'height', 'durationMs', 'byteSize', 'posterAssetId', 'derivedFromAssetId', 'reviewStatus', 'playbackCapability', 'assetPath'];
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
export function sanitizeLibrary(library) {
  if (library?.format !== 'prompt-case-library' || !SUPPORTED_CURATED_LIBRARY_VERSIONS.includes(library.version) || !Array.isArray(library.entries)) throw new Error('请选择 PromptDirector 导出的案例 ZIP 或投稿包');
  return {
    ...pick(library, ['format', 'version', 'schemaVersion', 'exportedAt']),
    taxonomy: { ...pick(library.taxonomy ?? {}, ['version', 'revision']), nodes: (library.taxonomy?.nodes ?? []).filter(node => ['content:prompt:image', 'content:prompt:video'].includes(node.id)) },
    entries: library.entries.map(entry => ({
      ...pick(entry, ['id', 'title', 'text', 'savedAt', 'schemaVersion', 'primaryMediaId']),
      classification: { pathIds: [(entry.mediaAssets ?? []).find(asset => asset.id === entry.primaryMediaId)?.kind === 'video' ? 'content:prompt:video' : 'content:prompt:image'], status: 'confirmed', source: 'manual' },
      ...Object.fromEntries(emptyPersonal.map(key => [key, []])),
      metadataLabels: (entry.metadataLabels ?? []).filter(label => /^(作者|权利)[:：]/u.test(label)),
      url: httpsUrl(entry.url),
      sourcePages: (entry.sourcePages ?? []).map(page => ({ title: String(page.title ?? ''), url: httpsUrl(page.url) })).filter(page => page.url),
      mediaAssets: (entry.mediaAssets ?? []).map(asset => pick(asset, assetKeys))
    }))
  };
}
export function entryAuthor(entry) {
  return String(entry.metadataLabels?.find(label => /^作者[:：]/u.test(label)) ?? '').replace(/^作者[:：]\s*/u, '').trim()
    || entry.mediaAssets?.find(asset => asset.sourceAuthor?.trim())?.sourceAuthor.trim() || '';
}
export function entrySource(entry) { return httpsUrl(entry.url) || entry.sourcePages?.map(page => httpsUrl(page.url)).find(Boolean) || ''; }
export function suggestedAuthor(entry) {
  const title = entry.mediaAssets?.find(asset => asset.id === entry.primaryMediaId)?.sourceTitle || entry.title || '';
  return String(title).match(/^(.+?)\s+·\s+\d{4}-\d{2}-\d{2}$/)?.[1]?.trim() || '';
}

export async function importPackage(paths, root, policy, progress = () => {}) {
  progress('正在检查包结构、完整性和媒体');
  let payload, cleaned = false;
  if (paths.length === 1) {
    if ((await stat(paths[0])).size > policy.maxSubmissionBytes) throw new Error('单包需小于 2 GiB，这是网站下载附件的容量边界');
    const bytes = await readFile(paths[0]);
    const zip = readStoredZip(bytes, { maxBytes: policy.maxSubmissionBytes, maxFiles: policy.maxFileCount, maxFileBytes: policy.maxSubmissionBytes });
    if (zip.has('library.json')) {
      const library = sanitizeLibrary(JSON.parse(Buffer.from(zip.get('library.json')).toString('utf8')));
      const cleanRoot = join(root, 'clean');
      await mkdir(cleanRoot, { recursive: true });
      await save(join(cleanRoot, 'library.json'), library);
      const names = new Set(['library.json']);
      for (const entry of library.entries) for (const asset of entry.mediaAssets) {
        const path = asset.assetPath;
        if (!/^(images|videos)\/[A-Za-z0-9._/-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('媒体路径无效');
        if (!zip.has(path)) throw new Error(`${entry.title} 缺少媒体文件`);
        if (names.has(path)) throw new Error('多个案例引用了相同媒体路径，请分别导出案例后检查');
        names.add(path);
        await mkdir(dirname(join(cleanRoot, path)), { recursive: true });
        await writeFile(join(cleanRoot, path), zip.get(path));
      }
      const cleanPath = join(root, 'clean-payload.zip');
      await writePromptDirectorZip(cleanPath, cleanRoot, names);
      payload = await readFile(cleanPath);
      cleaned = true;
    } else {
      payload = (await preflightSubmission(paths, { policy: { ...policy, maxTransportFileBytes: policy.maxSubmissionBytes } })).payload;
    }
  } else payload = (await preflightSubmission(paths, { policy })).payload;
  const checked = await inspectPayload(payload, policy);
  const zip = readStoredZip(payload, { maxBytes: policy.maxSubmissionBytes, maxFiles: policy.maxFileCount, maxFileBytes: policy.maxSubmissionBytes });
  const library = JSON.parse(Buffer.from(zip.get('library.json')).toString('utf8'));
  const ids = new Set();
  const mediaHashes = new Map();
  const duplicateIds = [];
  for (const entry of library.entries) {
    if (!entry.id || ids.has(entry.id)) throw new Error('案例编号缺失或重复');
    ids.add(entry.id);
    const primary = entry.mediaAssets.find(asset => asset.id === entry.primaryMediaId);
    if (!primary) throw new Error(`${entry.title} 的主媒体关系无效`);
    const pair = digest(zip.get(primary.assetPath)) + digest(String(entry.text).trim());
    if (mediaHashes.has(pair)) duplicateIds.push([mediaHashes.get(pair), entry.id]);
    else mediaHashes.set(pair, entry.id);
  }
  const contentRoot = join(root, 'content');
  for (const [name, bytes] of zip) {
    await mkdir(dirname(join(contentRoot, name)), { recursive: true });
    await writeFile(join(contentRoot, name), bytes);
  }
  const result = { ...checked, library, cleaned, duplicateIds, submissionId: digest(payload) };
  await save(join(root, 'import.json'), result);
  if (cleaned) {
    await rm(join(root, 'clean'), { recursive: true, force: true });
    await rm(join(root, 'clean-payload.zip'), { force: true });
  }
  return result;
}

export function reviewSelection(library, selection) {
  if (!selection.title?.trim() || !selection.publisher?.trim() || !selection.summary?.trim()) throw new Error('请填写合集标题、发布署名和简介');
  if (!['source_unverified', 'verified_original', 'verified_authorized'].includes(selection.rightsStatus)) throw new Error('请选择真实的权利状态');
  if (!selection.evidence?.trim()) throw new Error('请填写来源说明或授权依据，作为审核记录');
  const requested = new Map((selection.entries ?? []).map(item => [item.id, item]));
  if (!requested.size || requested.size !== selection.entries.length) throw new Error('至少选择一个案例，且不能重复选择');
  const entries = library.entries.filter(entry => requested.has(entry.id)).map(entry => {
    const edit = requested.get(entry.id);
    const author = String(edit.author ?? '').trim();
    const source = httpsUrl(edit.sourceUrl);
    if (!author) throw new Error(`${entry.title} 缺少原作者署名`);
    if (selection.rightsStatus !== 'verified_original' && !source) throw new Error(`${entry.title} 缺少可核验的来源链接`);
    return { ...entry, url: source, sourcePages: source ? [{ title: entry.title, url: source }] : [],
      metadataLabels: [`作者：${author}`, `权利：${rightsLabel(selection.rightsStatus)}`] };
  });
  if (entries.length !== requested.size) throw new Error('所选案例已变化，请重新检查');
  if (!entries.some(entry => entry.id === selection.coverId)) throw new Error('封面必须来自已选案例');
  return entries;
}
export function selectionDigest(selection) {
  const { confirmed, edits, ...content } = selection;
  return digest(JSON.stringify(content));
}
export function rightsLabel(status) {
  return { source_unverified: '第三方来源精选 · 权利归原作者 · 授权未核验', verified_original: '本人原创 · 权利归作者', verified_authorized: '已获授权 · 按授权范围分发' }[status];
}

export async function preparePackage({ root, selection, repository, siteUrl, reviewerId, policy, progress = () => {} }) {
  const imported = await json(join(root, 'import.json'));
  const entries = reviewSelection(imported.library, selection);
  const identity = digest(JSON.stringify({ submissionId: imported.submissionId, selection: selectionDigest(selection), reviewerId })).slice(0, 20);
  const packageId = `cases-${identity}`;
  const tag = `${packageId}-1.0.0`;
  const buildRoot = join(root, 'build', packageId);
  const packageRoot = join(buildRoot, 'package');
  const siteRoot = join(buildRoot, 'site');
  await mkdir(packageRoot, { recursive: true });
  const selectedLibrary = { ...imported.library, entries };
  await save(join(packageRoot, 'library.json'), selectedLibrary);
  const names = ['library.json'];
  const duplicatePairs = new Set();
  for (const entry of entries) {
    const primary = entry.mediaAssets.find(asset => asset.id === entry.primaryMediaId);
    const pair = await fileDigest(join(root, 'content', primary.assetPath)) + digest(entry.text.trim());
    if (duplicatePairs.has(pair)) throw new Error(`${entry.title} 与所选案例的媒体和提示词完全重复，请只保留一个`);
    duplicatePairs.add(pair);
    for (const asset of entry.mediaAssets) {
      const output = join(packageRoot, asset.assetPath);
      await mkdir(dirname(output), { recursive: true });
      await copyFile(join(root, 'content', asset.assetPath), output, constants.COPYFILE_FICLONE);
      names.push(asset.assetPath);
    }
  }
  progress('正在生成保留原始媒体的下载包');
  const archivePath = join(buildRoot, `${packageId}.zip`);
  await writePromptDirectorZip(archivePath, packageRoot, names);
  const archiveBytes = (await stat(archivePath)).size;
  if (archiveBytes > policy.maxSubmissionBytes) throw new Error('所选案例包超过单个 Release 附件容量，请减少本合集的案例数量');
  const sha256 = await fileDigest(archivePath);
  const updatedAt = new Date().toISOString();
  const publicUrl = path => new URL(path, siteUrl).href;
  const releaseUrl = `https://github.com/${repository}/releases/download/${tag}/`;
  const previewEntries = [], assets = [{ path: archivePath, name: `${packageId}.zip`, sha256 }];
  const siteFiles = [];
  for (const [index, entry] of entries.entries()) {
    progress(`正在生成网站预览 ${index + 1}/${entries.length}`);
    const primary = entry.mediaAssets.find(asset => asset.id === entry.primaryMediaId);
    const poster = primary.kind === 'video' ? entry.mediaAssets.find(asset => asset.id === primary.posterAssetId) : primary;
    const stem = digest(entry.id).slice(0, 20);
    const relative = `previews/${packageId}/media/${stem}.webp`;
    const output = join(siteRoot, relative);
    await mkdir(dirname(output), { recursive: true });
    // Website thumbnails follow the reviewer's visible preview setting; originals are copied untouched.
    const maxEdge = Number(selection.previewMaxEdge);
    if (!Number.isSafeInteger(maxEdge) || maxEdge < 1 || maxEdge > Math.sqrt(policy.maxImagePixels)) throw new Error('预览最长边设置无效');
    const source = join(root, 'content', poster.assetPath);
    const original = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', source])).streams[0];
    const ratio = Math.min(1, maxEdge / Math.max(original.width, original.height));
    await run('cwebp', ['-quiet', '-lossless', '-metadata', 'none', '-resize', String(Math.max(1, Math.round(original.width * ratio))), String(Math.max(1, Math.round(original.height * ratio))), source, '-o', output]);
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', output])).streams[0];
    siteFiles.push(relative);
    let video = {};
    if (primary.kind === 'video') {
      const path = join(root, 'content', primary.assetPath);
      const videoHash = await fileDigest(path), name = `${videoHash}.mp4`;
      if (!assets.some(asset => asset.name === name)) assets.push({ path, name, sha256: videoHash });
      video = { videoUrl: releaseUrl + name, videoSha256: videoHash, videoBytes: (await stat(path)).size, videoMimeType: 'video/mp4' };
    }
    previewEntries.push({ id: entry.id, title: entry.title, text: entry.text, author: entryAuthor(entry), rights: rightsLabel(selection.rightsStatus), sourceUrl: entrySource(entry), mediaKind: primary.kind, previewImageUrl: publicUrl(relative), width: probe.width, height: probe.height, ...video });
  }
  const cover = previewEntries.find(entry => entry.id === selection.coverId);
  const theme = normalizeTheme({ id: packageId, packageId, packageVersion: '1.0.0', title: selection.title.trim(), summary: selection.summary.trim(), author: selection.publisher.trim(), authorId: reviewerId,
    type: previewEntries.every(entry => entry.mediaKind === 'image') ? 'image_prompt' : previewEntries.every(entry => entry.mediaKind === 'video') ? 'video_prompt' : 'editorial',
    license: rightsLabel(selection.rightsStatus), rightsStatus: selection.rightsStatus, rightsReviewUrl: publicUrl(`reviews/${packageId}.json`),
    coverUrl: cover.previewImageUrl, previewUrl: publicUrl(`previews/${packageId}/preview.json`), downloadUrl: releaseUrl + `${packageId}.zip`, sha256, archiveBytes,
    caseCount: entries.length, imageCount: previewEntries.filter(entry => entry.mediaKind === 'image').length, videoCount: previewEntries.filter(entry => entry.mediaKind === 'video').length, updatedAt, order: 1 });
  const preview = normalizeSitePreview({ format: 'prompt-director-curated-preview', version: 1, catalogId: packageId, packageId, packageVersion: '1.0.0', entries: previewEntries }, theme);
  const review = normalizeSiteRightsReview({ format: 'prompt-director-curated-rights-review', version: 1, catalogId: packageId, packageId, packageVersion: '1.0.0', reviewerId, status: selection.rightsStatus, reviewedAt: updatedAt,
    evidence: { origin: selection.evidence.trim(), entryCount: entries.length, thirdPartySourceUrlCount: entries.filter(entry => entrySource(entry)).length, sourceRecordsRetainedByPublisher: true },
    distributionScope: ['公开网站预览', '原始媒体与提示词 ZIP 下载', '保存到本地资料库'] }, theme);
  for (const [relative, value] of [[`previews/${packageId}/preview.json`, preview], [`reviews/${packageId}.json`, review]]) {
    await save(join(siteRoot, relative), value); siteFiles.push(relative);
  }
  const siteDigests = Object.fromEntries(await Promise.all(siteFiles.map(async path => [path, await fileDigest(join(siteRoot, path))])));
  const result = { theme, tag, assets, siteFiles, siteDigests, siteRoot, repository, siteUrl, buildRoot, selection };
  await save(join(root, 'prepared.json'), result);
  return result;
}
