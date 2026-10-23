// Shared data access: rendered cases are ready immediately; other cases load on demand.
const websiteRoot=new URL('.',document.currentScript.src);
const pendingData=new Map();
const assetUrl=value=>value?new URL(value,websiteRoot).href:'';
const videoPlaybackUrl=media=>media.videoSha256?new URL('website/video/'+media.videoSha256+'.mp4',websiteRoot).pathname:media.videoUrl;
const languageRoot=()=>new URL(document.documentElement.lang==='en'?'en/':'',websiteRoot).pathname;
const viewPath=view=>languageRoot()+(view==='explore'?'':view+'/');
const packPath=p=>viewPath('collections')+encodeURIComponent(p.packageId)+'/';
const casePath=e=>languageRoot()+'cases/'+encodeURIComponent(e.pack.packageId)+'/'+encodeURIComponent(e.id)+'/';
const skillPath=s=>viewPath('skills')+encodeURIComponent(s.skillId)+'/';
const authorPath=p=>languageRoot()+'authors/'+encodeURIComponent(p.authorId)+'/';
function pageRoute(){
 const u=new URL(location),q=u.searchParams;
 if(['view','pack','author','skill'].some(k=>q.has(k)))return {view:q.get('view')||'explore',pack:q.get('pack')||'',case:q.get('case')||'',author:q.get('author')||'',skill:q.get('skill')||''};
 const parts=u.pathname.slice(languageRoot().length).split('/').filter(Boolean).map(decodeURIComponent);
 if(parts[0]==='cases'){const p=data.packs.find(p=>p.packageId===parts[1]);return {view:'case',case:p?`${p.id}/${parts[2]}`:''};}
 if(parts[0]==='collections'&&parts[1])return {view:'explore',pack:data.packs.find(p=>p.packageId===parts[1])?.id||'missing',case:q.get('case')||''};
 if(parts[0]==='skills'&&parts[1])return {view:'skill',skill:siteData.skills.find(s=>s.skillId===parts[1])?.id||'missing'};
 if(parts[0]==='authors')return {view:'author',author:parts[1]};
 return {view:['collections','skills','about','submit'].includes(parts[0])?parts[0]:'explore',case:q.get('case')||''};
}
function previewImage(e,{hero=false,className=''}={}){
 const variants=hero?data.heroImages:e.thumbnails,src=variants?.[0]?.url||e.previewImageUrl;
 const sizes=hero?'(min-width: 761px) 940px, 100vw':'(min-width: 1600px) 280px, (min-width: 1051px) 25vw, (min-width: 761px) 33vw, 50vw';
 return `<img ${className?`class="${esc(className)}"`:''} src="${esc(assetUrl(src))}" ${variants?.length?`srcset="${variants.map(v=>`${esc(assetUrl(v.url))} ${v.width}w`).join(', ')}" sizes="${sizes}"`:''} alt="${esc(e.title||'')}" loading="${hero?'eager':'lazy'}" ${hero?'fetchpriority="high"':''} decoding="async" width="${e.width||800}" height="${e.height||1000}">`;
}
function resolveMedia(value){
 if(Array.isArray(value))return value.map(resolveMedia);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
  ['previewImageUrl','videoUrl','coverUrl','previewUrl','detailsUrl','rightsReviewUrl','path'].includes(key)&&typeof item==='string'
    ?assetUrl(item):resolveMedia(item)]));
}
const initialBrowse=resolveMedia(JSON.parse(document.querySelector?.('#initial-browse-data')?.textContent||'{"packs":[]}'));
function readWebsiteJson(path){
 const url=assetUrl(path);
 if(!pendingData.has(url))pendingData.set(url,fetch(url).then(r=>{if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json()}).catch(error=>{pendingData.delete(url);throw error}));
 return pendingData.get(url);
}
async function readWebsite(){
 const [index,metadata]=await Promise.all([readWebsiteJson('website/index.json'),readWebsiteJson('website/site.json')]);
 if(index.version!==1||!Array.isArray(index.packs)||!Array.isArray(metadata.skills))throw Error('Invalid website catalog');
 if(!index.packs.every(p=>Number.isSafeInteger(metadata.metrics?.downloads?.[p.id])&&metadata.metrics.downloads[p.id]>=0))metadata.metrics=null;
 return [resolveMedia(index),resolveMedia(metadata)];
}
async function readCase(pack,id){
 const ready=initialBrowse.details?.[pack.id+'/'+id];
 if(ready)return ready;
 const initial=document.querySelector?.('#initial-case-data');
 if(initial){const value=JSON.parse(initial.textContent);if(value.pack===pack.id&&value.entry.id===id)return resolveMedia(value.entry);}
 const entry=await readWebsiteJson(pack.detailsUrl.replace(/\.json$/, '/'+encodeURIComponent(id)+'.json'));
 if(entry.id!==id&&!entry.memberEntryIds?.includes(id))throw Error('Case unavailable');
 return resolveMedia(entry);
}
function localizeCatalogs(data,siteData){
 if(typeof catalogEnglish==='undefined')return;
 for(const p of data.packs){p.originalTitle=p.title;Object.assign(p,catalogEnglish.packs[p.id]);p.author=catalogEnglish.labels[p.author]||p.author;p.license=catalogEnglish.labels[p.license]||p.license;for(const e of p.entries)e.author=catalogEnglish.labels[e.author]||e.author;}
 for(const s of siteData.skills){s.originalTitle=s.title;s.originalSummary=s.summary;Object.assign(s,catalogEnglish.skills[s.skillId]);s.author=catalogEnglish.labels[s.author]||s.author;}
}
const followingKey='promptdirector.curated.following.v1';
function readFollowing(){try{const list=JSON.parse(localStorage.getItem(followingKey)||'[]');return new Set(Array.isArray(list)?list.filter(x=>typeof x==='string'):[])}catch{return new Set()}}

function updatePageMetadata(){
 if(!data||!siteData)return;
 const english=document.documentElement.lang==='en',origin=siteData.origin,route=pageRoute();
 const entry=(dialog.open&&selected)||view==='case'&&all.find(e=>e.key===route.case);
 const pack=view==='explore'?data.packs.find(p=>p.id===packId):null,skill=view==='skill'?siteData.skills.find(s=>s.id===route.skill):null;
 const author=[...data.packs,...siteData.skills].find(p=>p.authorId===authorId);
 const names=english?{collections:'Curated collections',skills:'Creative Skills',about:'About PromptDirector',submit:'Share your work'}:{collections:'精选合集',skills:'精选 Skill',about:'关于 PromptDirector',submit:'分享投稿'};
 const name=entry?label(entry):pack?.title||skill?.title||(view==='author'?author?.author:names[view]);
 const title=name?name+' · PromptDirector':'PromptDirector · Spot it. Save it.';
 const path=entry?casePath(entry):pack?packPath(pack):skill?skillPath(skill):view==='author'?authorPath({authorId}):viewPath(view);
 const url=origin+path;
 document.title=title;
 document.querySelector('link[rel="canonical"]')?.setAttribute('href',url);
 for(const key of ['og:title','og:url'])document.querySelector(`meta[property="${key}"]`)?.setAttribute('content',key==='og:title'?title:url);
 document.querySelector('.language-link')?.setAttribute('href',path.startsWith('/en/')?path.slice(3):'/en'+path);
}
