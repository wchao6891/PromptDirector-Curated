import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, mkdir, readdir, stat, rename, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve, extname, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { json, save, run, digest } from './common.mjs';
import { importPackage, preparePackage, entryAuthor, entrySource, selectionDigest } from './package.mjs';
import { prepareSitePreview, publishPrepared } from './publish.mjs';
import { extractOfficialAttachmentUrls, downloadAttachment, submissionTransportLimits } from '../submission-preflight.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const UI_ROOT = join(import.meta.dirname, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.zip': 'application/zip' };

export async function createReviewDesk({ dataRoot, repoRoot = REPO_ROOT, port = 0 } = {}) {
  if (!dataRoot) throw new Error('缺少审核数据目录');
  await mkdir(dataRoot, { recursive: true });
  const policy = await json(join(repoRoot, 'submission-policy.json'));
  const token = randomBytes(32).toString('hex');
  const jobs = new Map();
  const uploading = new Set();
  let activeJob = null, origin;
  const configPath = join(dataRoot, 'config.json');
  let config;
  try { config = await json(configPath); }
  catch {
    const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
    const match = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (!match) throw new Error('仓库未配置 GitHub origin');
    const repository = match[1];
    config = { repository, siteUrl: `https://${repository.split('/')[0]}.github.io/${repository.split('/')[1]}/` };
    await save(configPath, config);
  }
  const sessionRoot = id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('审核记录编号无效');
    return join(dataRoot, id);
  };
  const status = async id => {
    const root = sessionRoot(id);
    const info = await json(join(root, 'session.json'));
    const job = jobs.get(id);
    return { ...info, ...(job ?? {}), id };
  };
  const startJob = (id, label, action) => {
    if (activeJob) throw new Error('另一个审核操作正在进行，请等待当前操作完成');
    const job = { busy: true, progress: label, error: '' };
    jobs.set(id, job); activeJob = id;
    const progress = message => { job.progress = message; };
    Promise.resolve().then(() => action(progress)).then(result => {
      job.result = result; job.progress = '操作完成';
    }).catch(error => { job.error = error.message; }).finally(async () => {
      job.busy = false; activeJob = null;
      try {
        const root = sessionRoot(id), info = await json(join(root, 'session.json'));
        await save(join(root, 'session.json'), { ...info, lastProgress: job.progress, lastError: job.error });
      } catch {}
    });
    return { started: true };
  };
  async function inspect(id, paths, progress) {
    const result = await importPackage(paths, sessionRoot(id), policy, progress);
    return { caseCount: result.library.entries.length, cleaned: result.cleaned, duplicateCount: result.duplicateIds.length };
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) return reply(res, 403, { error: '只允许本机审核地址' });
      if (req.headers.origin && req.headers.origin !== origin) return reply(res, 403, { error: '拒绝跨站操作' });
      const url = new URL(req.url, origin), path = decodeURIComponent(url.pathname);
      const authorized = req.headers['x-review-token'] === token || String(req.headers.cookie ?? '').split(';').some(item => item.trim() === `review-token=${token}`);
      if (path === '/api/unlock' && req.method === 'POST' && req.headers['x-review-token'] === token) {
        res.setHeader('Set-Cookie', `review-token=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return reply(res, 200, { ok: true });
      }
      if (path.startsWith('/desk/')) {
        const relative = path.slice('/desk/'.length) || 'index.html';
        return serve(req, res, inside(UI_ROOT, relative));
      }
      if (path === '/') { res.writeHead(302, { Location: '/desk/' }); return res.end(); }
      if (!authorized) return reply(res, 403, { error: '请使用启动审核台时打开的链接' });
      if (req.method !== 'GET' && req.headers['x-review-token'] !== token) return reply(res, 403, { error: '缺少本机操作凭据' });
      if (path === '/api/alive' && req.method === 'GET') return reply(res, 200, { ok: true });
      if (path === '/api/status') {
        const dependencies = await Promise.all(['node', 'ffmpeg', 'ffprobe', 'cwebp', 'git', 'gh'].map(async name => {
          try { await run(name, [name === 'ffmpeg' || name === 'ffprobe' || name === 'cwebp' ? '-version' : '--version']); return { name, ok: true }; }
          catch { return { name, ok: false }; }
        }));
        let account = null, authError = '';
        try { account = JSON.parse(await run('gh', ['api', 'user'])); } catch (error) { authError = error.message; }
        return reply(res, 200, { dependencies, account: account ? { login: account.login, reviewerId: `github-${account.id}` } : null, authError, config, dataRoot, maxSubmissionBytes: policy.maxSubmissionBytes });
      }
      if (path === '/api/sessions' && req.method === 'GET') {
        const sessions = [];
        for (const item of await readdir(dataRoot, { withFileTypes: true })) {
          if (item.isDirectory() && /^[a-f0-9-]{36}$/.test(item.name)) {
            try { sessions.push(await status(item.name)); } catch {}
          }
        }
        return reply(res, 200, sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      }
      if (path === '/api/sessions' && req.method === 'POST') {
        const input = await body(req), id = randomUUID(), root = sessionRoot(id);
        await mkdir(join(root, 'uploads'), { recursive: true });
        await save(join(root, 'session.json'), { title: String(input.title || '新审核'), selectAll: input.selectAll === true, createdAt: new Date().toISOString() });
        return reply(res, 200, { id });
      }
      const match = path.match(/^\/api\/sessions\/([a-f0-9-]{36})(?:\/(.*))?$/);
      if (match) {
        const [, id, action = ''] = match, root = sessionRoot(id);
        await status(id);
        if (!action && req.method === 'GET') return reply(res, 200, await status(id));
        if (action === 'upload' && req.method === 'POST') {
          if (activeJob) throw new Error('审核进行中，暂不能更改输入文件');
          if (uploading.has(id)) throw new Error('请等待当前文件保存完成');
          const filename = String(url.searchParams.get('name') ?? '');
          if (!/^[^/\\\x00-\x1f]+\.zip$/i.test(filename)) throw new Error('请选择 ZIP 文件');
          const files = await readdir(join(root, 'uploads'));
          if (files.length >= submissionTransportLimits(policy).maxFiles) throw new Error('分卷数量超过当前容量');
          const target = join(root, 'uploads', filename);
          const pending = `${target}.uploading`;
          const existingBytes = (await Promise.all(files.filter(name => name !== filename).map(async name => (await stat(join(root, 'uploads', name))).size))).reduce((sum, size) => sum + size, 0);
          const allowedBytes = Math.min(policy.maxSubmissionBytes, submissionTransportLimits(policy).maxBytes - existingBytes);
          if (allowedBytes <= 0 || Number(req.headers['content-length'] || 0) > allowedBytes) throw new Error('这些文件的总量超过整包容量');
          let bytes = 0;
          uploading.add(id);
          try {
            await pipeline(req, new Transform({ transform(chunk, encoding, done) {
              bytes += chunk.length;
              done(bytes > allowedBytes ? new Error('上传内容超过整包容量') : null, chunk);
            } }), createWriteStream(pending, { flags: 'wx' }));
            await rename(pending, target);
          } catch (error) { await unlink(pending).catch(() => {}); throw error; }
          finally { uploading.delete(id); }
          return reply(res, 200, { bytes });
        }
        if (action === 'inspect' && req.method === 'POST') {
          const paths = (await readdir(join(root, 'uploads'))).filter(name => name.endsWith('.zip')).map(name => join(root, 'uploads', name));
          return reply(res, 200, startJob(id, '正在检查本地案例包', progress => inspect(id, paths, progress)));
        }
        if (action === 'issue' && req.method === 'POST') {
          const input = await body(req), issue = new URL(input.url);
          const issueMatch = issue.pathname.match(/^\/([^/]+\/[^/]+)\/issues\/(\d+)$/);
          if (issue.protocol !== 'https:' || issue.hostname !== 'github.com' || issue.username || issue.password || issueMatch?.[1] !== config.repository) throw new Error('请输入当前精选仓库的 Issue 链接');
          return reply(res, 200, startJob(id, '正在读取投稿', async progress => {
            const issueData = JSON.parse(await run('gh', ['issue', 'view', issueMatch[2], '--repo', config.repository, '--json', 'title,body,url']));
            await save(join(root, 'issue.json'), issueData);
            const urls = extractOfficialAttachmentUrls(issueData.body), paths = [];
            const limits = submissionTransportLimits(policy);
            if (!urls.length || urls.length > limits.maxFiles) throw new Error('附件数量无效');
            let total = 0;
            for (const [index, attachment] of urls.entries()) {
              progress(`下载投稿附件 ${index + 1}/${urls.length}`);
              const target = join(root, 'uploads', digest(attachment) + '.zip');
              let size;
              try { size = (await stat(target)).size; }
              catch {
                const file = await downloadAttachment(attachment, policy);
                await writeFile(target + '.uploading', file.bytes);
                await rename(target + '.uploading', target); size = file.bytes.byteLength;
              }
              total += size;
              if (total > limits.maxBytes) throw new Error('投稿附件总量超过当前容量');
              paths.push(target);
            }
            return inspect(id, paths, progress);
          }));
        }
        if (action === 'entries' && req.method === 'GET') {
          const imported = await json(join(root, 'import.json'));
          let selection = null; try { selection = await json(join(root, 'selection.json')); } catch {}
          let issue = null; try { issue = await json(join(root, 'issue.json')); } catch {}
          const info = await json(join(root, 'session.json'));
          return reply(res, 200, { selectAll: info.selectAll === true, issue: issue && { title: issue.title, url: issue.url }, cleaned: imported.cleaned, duplicateIds: imported.duplicateIds, selection, entries: imported.library.entries.map(entry => ({
            id: entry.id, title: entry.title, text: entry.text, author: entryAuthor(entry), sourceUrl: entrySource(entry),
            primaryMediaId: entry.primaryMediaId, mediaAssets: entry.mediaAssets.map(asset => ({ ...asset, localUrl: `/api/sessions/${id}/media/${encodeURIComponent(asset.assetPath)}` }))
          })) });
        }
        if (action.startsWith('media/') && req.method === 'GET') return serve(req, res, inside(join(root, 'content'), action.slice(6)));
        if (action === 'selection' && req.method === 'POST') {
          if (activeJob) throw new Error('请等待当前操作完成再修改审核');
          const selection = await body(req);
          await save(join(root, 'selection.json'), selection);
          const info = await json(join(root, 'session.json'));
          await save(join(root, 'session.json'), { ...info, title: String(selection.title || info.title) });
          return reply(res, 200, { ok: true });
        }
        if (action === 'prepare' && req.method === 'POST') {
          const selection = await body(req);
          return reply(res, 200, startJob(id, '正在生成发布预览', async progress => {
            const account = JSON.parse(await run('gh', ['api', 'user']));
            await save(join(root, 'selection.json'), selection);
            const prepared = await preparePackage({ root, selection, ...config, reviewerId: `github-${account.id}`, policy, progress });
            progress('正在校验完整网站目录');
            await prepareSitePreview(prepared, repoRoot);
            await save(join(root, 'approved-preview.json'), { selectionDigest: selectionDigest(selection), packageId: prepared.theme.packageId });
            return { previewUrl: `/preview/${id}/?pack=${prepared.theme.id}`, downloadUrl: `/api/sessions/${id}/archive`, caseCount: prepared.theme.caseCount, bytes: prepared.theme.archiveBytes };
          }));
        }
        if (action === 'archive' && req.method === 'GET') {
          const prepared = await json(join(root, 'prepared.json'));
          res.setHeader('Content-Disposition', `attachment; filename="${prepared.theme.packageId}.zip"`);
          return serve(req, res, prepared.assets[0].path);
        }
        if (action === 'publish' && req.method === 'POST') {
          const input = await body(req);
          if (input.confirmPublish !== true) throw new Error('请确认公开发布');
          const approval = await json(join(root, 'approved-preview.json'));
          const selection = await json(join(root, 'selection.json'));
          if (!selection.confirmed) throw new Error('请确认已检查所选案例的内容、隐私与权利');
          if (selectionDigest(selection) !== approval.selectionDigest) throw new Error('审核选择已变化，请重新生成发布预览');
          return reply(res, 200, startJob(id, '开始公开发布', progress => publishPrepared(root, progress)));
        }
        if (action === 'receipt' && req.method === 'GET') return reply(res, 200, await json(join(root, 'publication.json')));
      }
      const previewMatch = path.match(/^\/preview\/([a-f0-9-]{36})\/(.*)$/);
      if (previewMatch && req.method === 'GET') {
        const root = sessionRoot(previewMatch[1]), prepared = await json(join(root, 'prepared.json'));
        const relative = previewMatch[2] || 'index.html';
        if (relative.startsWith('assets/')) {
          const asset = prepared.assets.find(item => item.name === relative.slice(7));
          if (!asset) throw new Error('预览文件不存在');
          return serve(req, res, asset.path);
        }
        if (relative === 'app.js') {
          let script = await readFile(join(prepared.buildRoot, 'preview/site/app.js'), 'utf8');
          const prefix = `/preview/${previewMatch[1]}`;
          script = script.replace('return `${url.pathname.replace', `return \`${prefix}\${url.pathname.replace`);
          const videos = Object.fromEntries(prepared.assets.filter(asset => asset.name.endsWith('.mp4')).map(asset => [`https://github.com/${config.repository}/releases/download/${prepared.tag}/${asset.name}`, `${prefix}/assets/${asset.name}`]));
          script = `const localReviewVideos = ${JSON.stringify(videos)};\n` + script.replaceAll('video.src = entry.videoUrl;', 'video.src = localReviewVideos[entry.videoUrl] || entry.videoUrl;');
          script = script.replace('download.href = item.downloadUrl;', `download.href = item.id === ${JSON.stringify(prepared.theme.id)} ? ${JSON.stringify(`${prefix}/assets/${prepared.theme.packageId}.zip`)} : item.downloadUrl;`);
          res.setHeader('Content-Type', MIME['.js']); return res.end(script);
        }
        return serve(req, res, inside(join(prepared.buildRoot, 'preview/site'), relative));
      }
      reply(res, 404, { error: '没有找到此操作' });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) reply(res, 400, { error: error.code === 'ENOENT' ? '尚未生成所需文件，请先检查案例包并生成预览' : error.message });
      else res.destroy();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, url: `${origin}/desk/#${token}`, token };
}

function inside(root, relative) {
  const path = resolve(root, relative);
  if (!path.startsWith(resolve(root) + sep)) throw new Error('文件路径无效');
  return path;
}
function reply(res, code, value) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('表单内容过大'); }
  return JSON.parse(text || '{}');
}
async function serve(req, res, path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('文件不存在');
  let start = 0, end = info.size - 1, code = 200;
  if (req.headers.range) {
    const match = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) { res.writeHead(416); return res.end(); }
    start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= info.size) { res.writeHead(416); return res.end(); }
    code = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
  }
  res.writeHead(code, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https: data:; media-src 'self' https: blob:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'self'" });
  await pipeline(createReadStream(path, { start, end }), res);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--data-dir');
  const dataRoot = index >= 0 ? resolve(args[index + 1]) : join(process.env.XDG_DATA_HOME || (process.platform === 'darwin' ? join(homedir(), 'Library/Application Support') : process.env.LOCALAPPDATA || join(homedir(), '.local/share')), 'PromptDirector-Review');
  const runningPath = join(dataRoot, 'running.json');
  let desk;
  try {
    const running = await json(runningPath);
    const url = new URL(running.origin);
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') {
      process.kill(running.pid, 0);
      if ((await fetch(new URL('/api/alive', url), { headers: { 'x-review-token': running.token } })).ok) desk = running;
    }
  } catch {}
  if (!desk) {
    desk = await createReviewDesk({ dataRoot });
    await writeFile(runningPath, JSON.stringify({ pid: process.pid, url: desk.url, origin: desk.origin, token: desk.token }), { mode: 0o600 });
  }
  process.stdout.write(`精选审核台：${desk.url}\n审核记录：${dataRoot}\n关闭此终端会停止审核台。\n`);
  if (!args.includes('--no-open')) {
    const command = process.platform === 'darwin' ? ['open', [desk.url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', desk.url]] : ['xdg-open', [desk.url]];
    await run(...command).catch(() => process.stdout.write('请在浏览器打开上方链接。\n'));
  }
}
