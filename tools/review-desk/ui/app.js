const $ = id => document.getElementById(id);
let token = location.hash.slice(1) || sessionStorage.getItem('review-token');
if (token) { sessionStorage.setItem('review-token', token); history.replaceState(null, '', location.pathname); }
const state = { id: '', entries: [], chosen: new Map(), coverId: '', page: 0, ready: false, busy: false };
const PAGE_SIZE = 24;
let health, saveTimer, detailEntry;
async function api(path, value, method) {
  const response = await fetch(path, { method: method || (value === undefined ? 'GET' : 'POST'), headers: { 'x-review-token': token || '', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}
function status(message, error = false) { $('status').hidden = false; $('status').textContent = message; $('status').classList.toggle('error', error); }
function busy(value) {
  state.busy = value;
  for (const control of document.querySelectorAll('button,input,select,textarea')) control.disabled = value;
  $('close-detail').disabled = false;
  if (!value && state.entries.length) renderCards();
}
const wrap = fn => async event => { try { await fn(event); } catch (error) { busy(false); status(error.message, true); } };
async function sessionList() {
  const sessions = await api('/api/sessions'); $('sessions').replaceChildren();
  for (const session of sessions) {
    const button = document.createElement('button'); button.textContent = session.title;
    button.classList.toggle('active', session.id === state.id);
    button.onclick = wrap(() => openSession(session.id)); $('sessions').append(button);
  }
}
async function newSession(title = '新审核') {
  const result = await api('/api/sessions', { title });
  state.id = result.id; state.ready = false; state.entries = []; state.chosen.clear(); state.page = 0; state.coverId = '';
  $('review').hidden = true; $('ready').hidden = true; $('receipt').hidden = true; $('intake').hidden = false; $('heading').textContent = title;
  await sessionList(); return state.id;
}
async function openSession(id) {
  clearTimeout(saveTimer);
  state.id = id; state.page = 0; state.ready = false; $('ready').hidden = true; $('receipt').hidden = true;
  const info = await api(`/api/sessions/${id}`); $('heading').textContent = info.title;
  await sessionList();
  if (info.busy) return waitJob();
  try { await loadEntries(); } catch { $('review').hidden = true; $('intake').hidden = false; }
  if (info.lastError) status(info.lastError, true);
  await showReceipt();
}
async function loadEntries() {
  const data = await api(`/api/sessions/${state.id}/entries`);
  state.entries = data.entries; state.chosen.clear();
  const selection = data.selection;
  for (const entry of state.entries) {
    if (!entry.author && entry.suggestedAuthor) { entry.author = entry.suggestedAuthor; entry.authorSuggested = true; }
    const previous = (selection?.edits || selection?.entries)?.find(item => item.id === entry.id);
    if (previous) { entry.author = previous.author; entry.sourceUrl = previous.sourceUrl; }
    if (selection?.entries.some(item => item.id === entry.id)) state.chosen.set(entry.id, true);
  }
  state.coverId = selection?.coverId || '';
  $('title').value = selection?.title || $('heading').textContent.replace(/\.zip$/i, '');
  $('publisher').value = selection?.publisher || health?.account?.login || '';
  $('summary').value = selection?.summary || '';
  $('evidence').value = selection?.evidence || '';
  $('rights').value = selection?.rightsStatus || 'source_unverified';
  $('preview-edge').value = selection?.previewMaxEdge || 1200;
  $('confirmed').checked = selection?.confirmed || false;
  $('duplicates').hidden = !data.duplicateIds.length;
  $('duplicates').textContent = `发现 ${data.duplicateIds.length} 组媒体与提示词完全相同的案例，请每组只收录一个。`;
  $('intake').hidden = true; $('review').hidden = false;
  renderCards();
  status(`预检通过：${state.entries.length} 个案例。${data.cleaned ? '已从普通导出包提取公开字段，私人整理信息不会发布。' : ''}${state.entries.some(entry => entry.authorSuggested) ? '部分署名根据“作者 · 日期”来源标题预填，需打开来源核实。' : ''}请逐项检查后选择收录。`);
}
function filtered() {
  const query = $('search').value.trim().toLowerCase();
  return state.entries.filter(entry => (!query || `${entry.title}\n${entry.text}`.toLowerCase().includes(query)) && (!$('only-selected').checked || state.chosen.has(entry.id)));
}
function renderCards() {
  const entries = filtered(), pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE)); state.page = Math.max(0, Math.min(state.page, pages - 1));
  $('cards').replaceChildren();
  $('counts').textContent = `${state.entries.length} 个案例 · 已选 ${state.chosen.size} 个 · ${state.coverId ? '已设置封面' : '未设置封面'}`;
  $('page').textContent = `${state.page + 1} / ${pages}`;
  $('previous').disabled = state.page === 0; $('next').disabled = state.page >= pages - 1;
  for (const entry of entries.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE)) {
    const primary = entry.mediaAssets.find(asset => asset.id === entry.primaryMediaId), image = primary.kind === 'video' ? entry.mediaAssets.find(asset => asset.id === primary.posterAssetId) : primary;
    const card = document.createElement('article'); card.className = 'card'; card.classList.toggle('selected', state.chosen.has(entry.id));
    const visual = document.createElement('button'); visual.className = 'visual'; visual.setAttribute('aria-label', `检查：${entry.title}`); visual.onclick = () => showDetail(entry);
    const img = document.createElement('img'); img.src = image.localUrl; img.alt = entry.title; img.loading = 'lazy'; visual.append(img); card.append(visual);
    if (primary.kind === 'video' || entry.id === state.coverId) { const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = entry.id === state.coverId ? '合集封面' : '视频'; card.append(badge); }
    const meta = document.createElement('div'); meta.className = 'meta'; const title = document.createElement('h3'); title.textContent = entry.title; meta.append(title);
    const label = document.createElement('label'); label.className = 'select'; const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = state.chosen.has(entry.id);
    checkbox.onchange = () => { select(entry.id, checkbox.checked); renderCards(); dirty(); };
    label.append(checkbox, document.createTextNode('收录')); const author = document.createElement('span'); author.textContent = (entry.author || '待补原作者') + (entry.authorSuggested ? ' · 待核实' : ''); author.className = entry.author && !entry.authorSuggested ? '' : 'missing'; label.append(author); meta.append(label); card.append(meta); $('cards').append(card);
  }
}
function select(id, value) { if (value) state.chosen.set(id, true); else { state.chosen.delete(id); if (state.coverId === id) state.coverId = ''; } }
function selection() {
  return { title: $('title').value, publisher: $('publisher').value, summary: $('summary').value, evidence: $('evidence').value, rightsStatus: $('rights').value, previewMaxEdge: Number($('preview-edge').value), confirmed: $('confirmed').checked, coverId: state.coverId,
    entries: state.entries.filter(entry => state.chosen.has(entry.id)).map(entry => ({ id: entry.id, author: entry.author, sourceUrl: entry.sourceUrl })),
    edits: state.entries.map(entry => ({ id: entry.id, author: entry.author, sourceUrl: entry.sourceUrl })) };
}
function dirty() {
  state.ready = false; $('ready').hidden = true; $('confirmed').checked = false; clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSelection().catch(error => status(`审核进度保存失败：${error.message}`, true)), 600);
}
async function saveSelection() { if (state.id && state.entries.length) await api(`/api/sessions/${state.id}/selection`, selection()); }
function showDetail(entry) {
  detailEntry = entry; $('detail-title').textContent = entry.title; $('detail-prompt').textContent = entry.text;
  $('detail-author').value = entry.author; $('detail-source').value = entry.sourceUrl; $('detail-selected').checked = state.chosen.has(entry.id);
  $('source-link').href = entry.sourceUrl || '#'; $('source-link').hidden = !entry.sourceUrl;
  $('detail-media').replaceChildren();
  const primary = entry.mediaAssets.find(asset => asset.id === entry.primaryMediaId);
  const media = document.createElement(primary.kind === 'video' ? 'video' : 'img'); media.src = primary.localUrl;
  if (primary.kind === 'video') { media.controls = true; media.preload = 'metadata'; } else media.alt = entry.title;
  $('detail-media').append(media); $('detail').showModal();
}
function applyDetail() {
  if (!detailEntry) return;
  detailEntry.author = $('detail-author').value; detailEntry.sourceUrl = $('detail-source').value;
  select(detailEntry.id, $('detail-selected').checked); renderCards(); dirty();
}
async function waitJob() {
  busy(true);
  while (true) {
    const info = await api(`/api/sessions/${state.id}`); status(info.progress || '正在处理…');
    if (!info.busy) {
      busy(false);
      if (info.error) throw new Error(info.error);
      if (info.result?.previewUrl) {
        state.ready = true; $('ready').hidden = false; $('preview-link').href = info.result.previewUrl; $('archive-link').href = info.result.downloadUrl;
        status(`网站预览已生成：${info.result.caseCount} 个案例，原始下载包 ${(info.result.bytes / 1024 ** 2).toFixed(1)} MiB。尚未公开发布。`);
      } else if (info.result?.completed) { await showReceipt(); }
      else await loadEntries();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
}
async function showReceipt() {
  try {
    const receipt = await api(`/api/sessions/${state.id}/receipt`); $('receipt').hidden = false; $('receipt').replaceChildren();
    const message = document.createElement('p'); message.textContent = receipt.completed ? '发布成功，已核对线上网站。' : `发布尚未完成：${receipt.error || receipt.phase}`; $('receipt').append(message);
    for (const [label, href] of [['打开网站 ↗', receipt.siteUrl], ['查看发布文件 ↗', receipt.releaseUrl]]) if (href) { const link = document.createElement('a'); link.textContent = label; link.href = href; link.target = '_blank'; link.rel = 'noreferrer'; link.style.marginRight = '20px'; $('receipt').append(link); }
  } catch {}
}
$('new-session').onclick = wrap(() => newSession());
$('files').onchange = wrap(async () => {
  const files = [...$('files').files]; if (!files.length) return;
  await newSession(files.length === 1 ? files[0].name : `${files.length} 卷投稿审核`); busy(true);
  for (const [index, file] of files.entries()) {
    status(`正在保存到本机 ${index + 1}/${files.length}：${file.name}`);
    const response = await fetch(`/api/sessions/${state.id}/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'x-review-token': token }, body: file });
    if (!response.ok) throw new Error((await response.json()).error || '文件保存失败');
  }
  await api(`/api/sessions/${state.id}/inspect`, {}); await waitJob();
});
$('issue-form').onsubmit = wrap(async event => { event.preventDefault(); const url = $('issue-url').value; await newSession('GitHub 投稿审核'); await api(`/api/sessions/${state.id}/issue`, { url }); await waitJob(); });
$('search').oninput = $('only-selected').onchange = () => { state.page = 0; renderCards(); };
$('previous').onclick = () => { state.page--; renderCards(); }; $('next').onclick = () => { state.page++; renderCards(); };
for (const [id, value] of [['select-page', true], ['clear-page', false]]) $(id).onclick = () => { filtered().slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE).forEach(entry => select(entry.id, value)); renderCards(); dirty(); };
$('close-detail').onclick = () => $('detail').close(); $('detail').onclose = () => { applyDetail(); $('detail-media').querySelector('video')?.pause(); detailEntry = null; };
$('use-cover').onclick = () => { $('detail-selected').checked = true; state.coverId = detailEntry.id; applyDetail(); status('已设为合集封面'); };
for (const id of ['title', 'publisher', 'summary', 'evidence', 'rights', 'preview-edge']) $(id).oninput = dirty;
$('save').onclick = wrap(async () => { clearTimeout(saveTimer); await saveSelection(); status('审核进度已保存在本机'); });
$('prepare').onclick = wrap(async () => { clearTimeout(saveTimer); await saveSelection(); await api(`/api/sessions/${state.id}/prepare`, selection()); await waitJob(); });
$('publish').onclick = wrap(async () => {
  if (!state.ready) throw new Error('请先生成网站预览');
  if (!$('confirmed').checked) throw new Error('请确认已检查所选案例的内容、隐私与权利');
  if (!confirm(`将公开发布“${$('title').value}”的 ${state.chosen.size} 个案例及原始媒体，并更新精选网站。确认发布？`)) return;
  await saveSelection();
  await api(`/api/sessions/${state.id}/publish`, { confirmPublish: true }); await waitJob();
});
try {
  await api('/api/unlock', {}); await sessionList(); health = await api('/api/status');
  $('environment').textContent = `${health.dependencies.map(item => `${item.ok ? '✓' : '缺少'} ${item.name}`).join(' · ')}\n${health.account ? `GitHub：${health.account.login}` : 'GitHub 尚未登录或网络不可用'}\n${health.dataRoot}`;
  $('public-site').href = health.config.siteUrl;
  const missing = health.dependencies.filter(item => !item.ok).map(item => item.name);
  if (missing.length) status(`需先安装：${missing.join('、')}。请参阅审核台使用说明。`, true);
  else if (!health.account) status('本地文件仍可检查；生成发布预览与上架前，请完成 GitHub CLI 登录并确保网络可用。', true);
} catch (error) { status(error.message, true); }
