// Shared data access for both languages. Full prompts load only when needed.
const websiteRoot=new URL('.',document.currentScript.src);
const pendingData=new Map();
const assetUrl=value=>value?new URL(value,websiteRoot).href:'';
function resolveMedia(value){
 if(Array.isArray(value))return value.map(resolveMedia);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
  ['previewImageUrl','videoUrl','coverUrl','previewUrl','detailsUrl','rightsReviewUrl','path'].includes(key)&&typeof item==='string'
    ?assetUrl(item):resolveMedia(item)]));
}
function readWebsiteJson(path){
 const url=assetUrl(path);
 if(!pendingData.has(url))pendingData.set(url,fetch(url).then(r=>{if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json()}).catch(error=>{pendingData.delete(url);throw error}));
 return pendingData.get(url);
}
async function readWebsite(){
 const [index,metadata]=await Promise.all([readWebsiteJson('website/index.json'),readWebsiteJson('website/site.json')]);
 if(index.version!==1||!Array.isArray(index.packs)||!Array.isArray(metadata.skills))throw Error('Invalid website catalog');
 return [resolveMedia(index),resolveMedia(metadata)];
}
async function readCase(pack,id){
 const entries=await readWebsiteJson(pack.detailsUrl);
 const entry=entries.find(e=>e.id===id||e.memberEntryIds?.includes(id));
 if(!entry)throw Error('Case unavailable');
 return resolveMedia(entry);
}
function localizeCatalogs(data,siteData){
 if(typeof catalogEnglish==='undefined')return;
 for(const p of data.packs){p.originalTitle=p.title;Object.assign(p,catalogEnglish.packs[p.id]);p.author=catalogEnglish.labels[p.author]||p.author;for(const e of p.entries)e.author=catalogEnglish.labels[e.author]||e.author;}
 for(const s of siteData.skills){s.originalTitle=s.title;s.originalSummary=s.summary;Object.assign(s,catalogEnglish.skills[s.skillId]);s.author=catalogEnglish.labels[s.author]||s.author;}
}
const followingKey='promptdirector.curated.following.v1';
function readFollowing(){try{const list=JSON.parse(localStorage.getItem(followingKey)||'[]');return new Set(Array.isArray(list)?list.filter(x=>typeof x==='string'):[])}catch{return new Set()}}
