import { groupCuratedPreview } from '../site/curated-media-gallery.js';

export function localAsset(value, legacyOrigin) {
  if (typeof value !== 'string') return value;
  return value.startsWith(legacyOrigin) ? value.slice(legacyOrigin.length) : value;
}
export function mapAssetUrls(value, legacyOrigin) {
  if (Array.isArray(value)) return value.map(v => mapAssetUrls(v, legacyOrigin));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,
    /^(previewImageUrl|videoUrl|coverUrl|previewUrl|rightsReviewUrl|path)$/.test(k)
      ? localAsset(v, legacyOrigin) : mapAssetUrls(v, legacyOrigin)]));
}
export function buildPackage(theme, preview, publishedAt, legacyOrigin) {
  if (!Number.isFinite(Date.parse(publishedAt))) throw Error(`Missing first publication date: ${theme.id}`);
  const grouped = groupCuratedPreview(preview.entries);
  const details = mapAssetUrls(grouped, legacyOrigin);
  const caseCounts = {image:0, video:0};
  const search = [];
  const entries = details.map(e => {
    const kinds = [...new Set((e.media?.length ? e.media : [e]).map(m => m.mediaKind))];
    for (const kind of kinds) if (kind in caseCounts) caseCounts[kind]++;
    const key = `${theme.id}/${e.id}`;
    search.push([key, [e.text,...(e.media||[]).map(m=>m.text)].filter(Boolean).join('\n')]);
    return {id:e.id,key,title:e.title,author:e.author,mediaKind:e.mediaKind,mediaKinds:kinds,
      previewImageUrl:e.previewImageUrl,width:e.width,height:e.height,videoUrl:e.videoUrl,videoSha256:e.videoSha256};
  });
  return {pack:{...mapAssetUrls(theme,legacyOrigin),publishedAt,caseCounts,caseCount:entries.length,
    detailsUrl:`website/details/${theme.packageId}.json`,entries},details,search};
}
