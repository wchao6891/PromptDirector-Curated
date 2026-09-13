import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSelection, selectEveryEntry, quickPublish } from '../tools/review-desk/ui/workflow.js';

const entries = Array.from({ length: 240 }, (_, index) => ({ id: `test-${index}`, author: '', sourceUrl: 'https://example.com/work' }));
const defaults = { title: '测试合集.zip', publisher: '测试发布者', selectAll: true };

test('自己的包首次导入全选所有页，自动封面与信息，不推定为本人原创', () => {
  const result = defaultSelection(entries, null, defaults);
  assert.equal(result.entries.length, 240);
  assert.equal(result.coverId, entries[0].id);
  assert.equal(result.title, '测试合集');
  assert.ok(result.summary && result.evidence);
  assert.equal(result.rightsStatus, 'source_unverified');
  assert.notEqual(result.confirmed, true);
});
test('已保存选择和手工信息优先，别人投稿默认不勾选，全选不依赖分页或筛选', () => {
  const saved = { entries: entries.slice(0, 230), title: '手工标题', evidence: '原始依据', coverId: entries[5].id };
  const result = defaultSelection(entries, saved, defaults);
  assert.equal(result.entries.length, 230);
  assert.equal(result.title, saved.title);
  assert.equal(result.evidence, saved.evidence);
  assert.equal(result.coverId, saved.coverId);
  const other = defaultSelection(entries, null, { ...defaults, selectAll: false, issueUrl: 'https://github.com/example/repo/issues/1' });
  assert.equal(other.entries.length, 0);
  assert.match(other.evidence, /issues\/1/);
  assert.equal(selectEveryEntry(entries).size, 240);
});
test('快捷发布先完成准备再上传，准备失败绝不上传', async () => {
  const calls = [];
  await quickPublish({ prepare: async () => calls.push('prepare'), publish: async () => calls.push('publish') });
  assert.deepEqual(calls, ['prepare', 'publish']);
  calls.length = 0;
  await assert.rejects(quickPublish({ prepare: async () => { throw new Error('检查失败'); }, publish: async () => calls.push('publish') }), /检查失败/);
  assert.deepEqual(calls, []);
});
