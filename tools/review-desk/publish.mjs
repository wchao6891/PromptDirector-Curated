import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { normalizeSiteCatalog, normalizeSiteMetrics } from '../curated-site-data.mjs';
import { json, save, run, fileDigest } from './common.mjs';

export function mergeCatalog(catalog, theme) {
  const old = catalog.themes.find(item => item.id === theme.id);
  if (old && old.sha256 !== theme.sha256) throw new Error('同一发布编号已存在不同内容，停止覆盖');
  const order = old?.order ?? Math.max(0, ...catalog.themes.map(item => item.order)) + 1;
  return normalizeSiteCatalog({ ...catalog, updatedAt: new Date().toISOString(), themes: [...catalog.themes.filter(item => item.id !== theme.id), { ...theme, order }] });
}

export async function stageSite(prepared, checkout, downloads) {
  const site = join(checkout, 'site');
  for (const relative of prepared.siteFiles) {
    await mkdir(dirname(join(site, relative)), { recursive: true });
    await cp(join(prepared.siteRoot, relative), join(site, relative));
  }
  const catalogPath = join(site, 'public-catalog.json');
  const catalog = mergeCatalog(await json(catalogPath), prepared.theme);
  await save(catalogPath, catalog);
  const metricsPath = join(site, 'metrics.json');
  const metrics = await json(metricsPath);
  metrics.downloads[prepared.theme.id] = downloads;
  metrics.updatedAt = new Date().toISOString();
  normalizeSiteMetrics(metrics, catalog);
  await save(metricsPath, metrics);
}

export async function prepareSitePreview(prepared, repoRoot) {
  const checkout = join(prepared.buildRoot, 'preview');
  await mkdir(checkout, { recursive: true });
  await cp(join(repoRoot, 'site'), join(checkout, 'site'), { recursive: true });
  await cp(join(repoRoot, 'tools'), join(checkout, 'tools'), { recursive: true });
  // This is a local preview; live download counts are queried from Release API on publication.
  await stageSite(prepared, checkout, 0);
  await run(process.execPath, ['tools/validate-catalog.mjs'], { cwd: checkout });
  return checkout;
}

export async function publishPrepared(root, progress = () => {}, { execute = run, fetchImpl = globalThis.fetch } = {}) {
  const prepared = await json(join(root, 'prepared.json'));
  const { repository, theme, tag } = prepared;
  const receiptPath = join(root, 'publication.json');
  const receipt = { packageId: theme.packageId, tag, phase: 'checking', completed: false };
  const phase = async (name, message) => { receipt.phase = name; progress(message); await save(receiptPath, receipt); };
  const api = async (...args) => JSON.parse(await execute('gh', ['api', ...args]));
  try {
    await phase('checking', '正在检查 GitHub 登录、仓库权限和待发布文件');
    const account = await api('user');
    const repo = await api(`repos/${repository}`);
    if (!repo.permissions?.push) throw new Error('当前 GitHub 账号没有此仓库的发布权限');
    if (theme.authorId !== `github-${account.id}`) throw new Error('登录账号已变化，请重新生成发布预览');
    for (const asset of prepared.assets) {
      if (await fileDigest(asset.path) !== asset.sha256) throw new Error('预览后文件发生变化，请重新检查');
    }
    for (const relative of prepared.siteFiles) {
      if (await fileDigest(join(prepared.siteRoot, relative)) !== prepared.siteDigests[relative]) throw new Error('预览后网站文件发生变化，请重新生成预览');
    }
    const checkout = join(prepared.buildRoot, 'publication-checkout');
    try { await stat(join(checkout, '.git')); }
    catch { await execute('gh', ['repo', 'clone', repository, checkout, '--', '--depth', '1', '--branch', repo.default_branch]); }
    // Only the dedicated disposable publication checkout is updated.
    await execute('git', ['fetch', 'origin', repo.default_branch], { cwd: checkout });
    await execute('git', ['reset', '--hard', `origin/${repo.default_branch}`], { cwd: checkout });
    await stageSite(prepared, checkout, 0);
    await execute(process.execPath, ['tools/validate-catalog.mjs'], { cwd: checkout });
    await phase('release', '正在上传原始案例包与视频，尚未更新网站');
    let release;
    try { release = await api(`repos/${repository}/releases/tags/${tag}`); }
    catch (error) {
      if (!error.message.includes('404')) throw error;
      const notesPath = join(prepared.buildRoot, 'release-notes.md');
      await saveText(notesPath, `${theme.title}\n\n${theme.summary}\n\n${theme.license}\n\n${theme.caseCount} 个案例。下载包保留审核后的原始媒体与提示词。\n`);
      await execute('gh', ['release', 'create', tag, '--repo', repository, '--target', repo.default_branch, '--draft', '--title', theme.title, '--notes-file', notesPath]);
      release = await api(`repos/${repository}/releases/tags/${tag}`);
    }
    for (const [index, asset] of prepared.assets.entries()) {
      progress(`正在核对/上传文件 ${index + 1}/${prepared.assets.length}`);
      const existing = release.assets.find(item => item.name === asset.name);
      if (existing) {
        if (existing.digest !== `sha256:${asset.sha256}` || existing.size !== (await stat(asset.path)).size) throw new Error(`远程文件 ${asset.name} 与审核结果不一致，未覆盖`);
      } else {
        if (!release.draft) throw new Error('已公开的发布版本缺少文件，不能向已有版本追加内容');
        const uploadRoot = join(prepared.buildRoot, 'upload');
        await mkdir(uploadRoot, { recursive: true });
        const uploadPath = join(uploadRoot, asset.name);
        await cp(asset.path, uploadPath);
        await execute('gh', ['release', 'upload', tag, uploadPath, '--repo', repository]);
      }
    }
    release = await api(`repos/${repository}/releases/tags/${tag}`);
    for (const asset of prepared.assets) {
      const actual = release.assets.find(item => item.name === asset.name);
      if (actual?.digest !== `sha256:${asset.sha256}`) throw new Error(`上传后摘要核验失败：${asset.name}`);
    }
    if (release.draft) await execute('gh', ['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest=false']);
    receipt.releaseUrl = release.html_url;
    const count = release.assets.find(asset => asset.name === `${theme.packageId}.zip`)?.download_count;
    if (!Number.isSafeInteger(count)) throw new Error('未能获取真实下载量');
    await phase('catalog', '文件已发布，正在更新网站目录');
    await stageSite(prepared, checkout, count);
    await execute(process.execPath, ['tools/validate-catalog.mjs'], { cwd: checkout });
    await execute('git', ['status', '--short'], { cwd: checkout });
    await execute('git', ['add', '--', 'site/public-catalog.json', 'site/metrics.json', ...prepared.siteFiles.map(path => `site/${path}`)], { cwd: checkout });
    const changed = await execute('git', ['diff', '--cached', '--name-only'], { cwd: checkout });
    if (changed) {
      const messagePath = join(prepared.buildRoot, 'commit-message.txt');
      await saveText(messagePath, `Publish reviewed case collection: ${theme.title}\n\nPublish ${theme.caseCount} selected cases and preserve original media.\n\nConstraint: Human-reviewed selection and matching asset hashes\nRejected: Overwriting existing immutable assets\nConfidence: high\nScope-risk: narrow\nTested: Package preflight, site validation, remote asset hashes\nNot-tested: Other users' installed extensions\n`);
      await execute('git', ['-c', `user.name=${account.login}`, '-c', `user.email=${account.id}+${account.login}@users.noreply.github.com`, 'commit', '--file', messagePath], { cwd: checkout });
      await execute('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', 'origin', `HEAD:${repo.default_branch}`], { cwd: checkout });
    }
    receipt.commit = await execute('git', ['rev-parse', 'HEAD'], { cwd: checkout });
    await phase('pages', '目录已提交，正在等待网站部署并核对线上内容');
    await execute('gh', ['workflow', 'run', 'pages.yml', '--repo', repository, '--ref', repo.default_branch]);
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      const response = await fetchImpl(new URL(`public-catalog.json?review=${Date.now()}`, prepared.siteUrl), { signal: AbortSignal.timeout(30000) });
      if (response.ok) {
        const live = await response.json();
        const liveTheme = live.themes?.find(item => item.id === theme.id);
        if (liveTheme?.sha256 === theme.sha256 && liveTheme.caseCount === theme.caseCount) {
          const previewResponse = await fetchImpl(`${theme.previewUrl}?review=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
          if (previewResponse.ok && (await previewResponse.json()).entries?.length === theme.caseCount) {
            receipt.completed = true; receipt.phase = 'published';
            receipt.siteUrl = new URL(`?pack=${encodeURIComponent(theme.id)}`, prepared.siteUrl).href;
            await save(receiptPath, receipt);
            progress('发布成功：已核对线上目录、案例预览与下载文件');
            return receipt;
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error('文件和目录已发布，但网站部署尚未验证成功。可稍后重试，工具会核对并复用已有文件');
  } catch (error) {
    receipt.error = error.message;
    await save(receiptPath, receipt);
    throw new Error(`${error.message}（当前阶段：${receipt.phase}）`);
  }
}

async function saveText(path, text) { await writeFile(path, text); }
