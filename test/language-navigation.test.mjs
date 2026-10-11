import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { extractOfficialAttachmentUrls } from '../tools/submission-preflight.mjs';
const source = await readFile(new URL('../site/lang.js', import.meta.url), 'utf8');
function visit(href, { stored, languages = ['en-US', 'zh-CN'], htmlLang = 'zh-CN', blockedStorage = false } = {}) {
  const location = new URL(href);
  let redirected;
  location.replace = value => redirected = value;
  const events = {};
  const links = [];
  vm.runInNewContext(source, {
    URL, URLSearchParams, location,
    navigator: { languages, language: languages[0], userAgent: 'Browser', webdriver: true },
    localStorage: { getItem() { if (blockedStorage) throw Error(); return stored; }, setItem(key, value) { if (blockedStorage) throw Error(); stored = value; } },
    document: { documentElement: { lang: htmlLang }, addEventListener(type, callback) { events[type] = callback; }, querySelectorAll: () => links }
  });
  return { get redirected() { return redirected; }, events, links, location };
}
test('English-first visitors retain shared pack, query and anchor even with Chinese as secondary language', () => {
  const page = visit('https://example.com/curated/?pack=featured%3Avol-1&q=light#details');
  assert.equal(page.redirected, 'https://example.com/curated/en/?pack=featured%3Avol-1&q=light#details');
});
test('explicit Chinese and saved Chinese choices win; blocked storage still follows explicit language', () => {
  assert.equal(visit('https://example.com/curated/?lang=zh-CN&pack=one').redirected, undefined);
  assert.equal(visit('https://example.com/curated/', { stored:'zh-CN' }).redirected, undefined);
  assert.equal(visit('https://example.com/curated/guide.html?lang=en#install', { blockedStorage:true }).redirected, 'https://example.com/curated/en/guide.html?lang=en#install');
  assert.equal(visit('https://example.com/curated/en/?pack=one', { htmlLang:'en',stored:'zh-CN' }).redirected, undefined);
});
test('language switch recomputes the current pack after in-page navigation and preserves anchors', () => {
  const page = visit('https://example.com/curated/en/?pack=old', {htmlLang:'en'});
  const link = { href:'../?lang=zh-CN', getAttribute(key) { return key === 'href' ? this.href : 'zh-CN'; } };
  page.links.push(link); page.events.DOMContentLoaded();
  page.location.search='?pack=new%3Apack'; page.location.hash='#detail';
  page.events.click({target:{closest:()=>link}});
  assert.equal(link.href,'https://example.com/curated/?pack=new%3Apack&lang=zh-CN#detail');
});
test('English and Chinese submission headings do not change official attachment extraction', () => {
  const attachment='https://github.com/user-attachments/files/123456/pack.zip';
  const zh=`### 公开署名\nAuthor\n### 投稿包\n[pack.zip](${attachment})`;
  const en=`### Public attribution\nAuthor\n### Submission package\n[pack.zip](${attachment})`;
  assert.deepEqual(extractOfficialAttachmentUrls(en),extractOfficialAttachmentUrls(zh));
  assert.equal(extractOfficialAttachmentUrls(en).length,1);
});
