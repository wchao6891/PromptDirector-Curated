export function defaultSelection(entries, saved, { title, publisher, issueUrl = '', selectAll = false }) {
  const chosen = saved?.entries ?? (selectAll ? entries.map(entry => ({ id: entry.id, author: entry.author, sourceUrl: entry.sourceUrl })) : []);
  return {
    ...saved,
    title: saved?.title || title.replace(/\.zip$/i, ''),
    publisher: saved?.publisher || publisher,
    summary: saved?.summary || `${title.replace(/\.zip$/i, '')}，收录原始媒体与提示词。`,
    evidence: saved?.evidence || (issueUrl ? `投稿来源：${issueUrl}` : '通过本机精选审核台整理，案例来源链接随内容保留。'),
    rightsStatus: saved?.rightsStatus || 'source_unverified',
    previewMaxEdge: saved?.previewMaxEdge || 1200,
    entries: chosen,
    coverId: chosen.some(entry => entry.id === saved?.coverId) ? saved.coverId : chosen[0]?.id || ''
  };
}

export function selectEveryEntry(entries) { return new Map(entries.map(entry => [entry.id, true])); }

// A deliberate publication click starts both phases; preparation failure stops upload.
export async function quickPublish({ prepare, publish }) {
  await prepare();
  await publish();
}
