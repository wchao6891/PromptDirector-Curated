import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildPackage,mapAssetUrls} from '../tools/website-data.mjs';
const legacy='https://wchao6891.github.io/PromptDirector-Curated/';
const theme={id:'test',packageId:'test-package',imageCount:1,videoCount:1};
const video={id:'video',title:'A film',text:'Original prompt\nLine 2',author:'Creator',mediaKind:'video',previewImageUrl:legacy+'previews/cover.webp',videoUrl:'https://github.com/owner/repo/releases/download/media/video.mp4'};
test('a video cover must never turn a video-only package into mixed cases',()=>{
 const {pack,details,search}=buildPackage(theme,{entries:[video]},'2026-10-01T00:00:00Z',legacy);
 assert.deepEqual(pack.caseCounts,{image:0,video:1});assert.equal(pack.entries[0].text,undefined);
 assert.equal(details[0].text,video.text);assert.equal(search[0][1],video.text);
 assert.equal(pack.entries[0].previewImageUrl,'previews/cover.webp');assert.equal(details[0].videoUrl,video.videoUrl);
});
test('a mixed compound retains member prompts, sources and both filter types',()=>{
 const first={...video,id:'a',compound:{title:'Sequence',memberEntryIds:['a','b']},sourceUrl:'https://example.com/a'};
 const second={...video,id:'b',mediaKind:'image',text:'Second prompt',sourceUrl:'https://example.com/b'};
 const {pack,details}=buildPackage(theme,{entries:[first,second]},'2026-10-01T00:00:00Z',legacy);
 assert.equal(pack.entries.length,1);assert.deepEqual(pack.caseCounts,{image:1,video:1});
 assert.deepEqual(details[0].media.map(x=>[x.text,x.sourceUrl]),[[video.text,first.sourceUrl],[second.text,second.sourceUrl]]);
});
test('stable case links survive preview reorder and text edits',()=>{
 const a=buildPackage(theme,{entries:[video]},'2026-10-01T00:00:00Z',legacy);
 const b=buildPackage({...theme,updatedAt:'2026-11-01T00:00:00Z'},{entries:[{...video,id:'new'},{...video,text:'Edited'}]},a.pack.publishedAt,legacy);
 assert.equal(a.pack.entries[0].key,b.pack.entries[1].key);assert.equal(a.pack.publishedAt,b.pack.publishedAt);
});
test('only asset fields are relocated; prompt text and source attribution are not rewritten',()=>{
 const value={previewImageUrl:legacy+'x.webp',text:legacy+'original',sourceUrl:legacy+'author',media:[{videoUrl:legacy+'v.mp4'}]};
 const output=mapAssetUrls(value,legacy);assert.equal(output.text,value.text);assert.equal(output.sourceUrl,value.sourceUrl);assert.equal(output.media[0].videoUrl,'v.mp4');
});
test('unknown first publication dates fail instead of silently sorting by edit date',()=>{
 assert.throws(()=>buildPackage(theme,{entries:[video]},undefined,legacy),/first publication/);
});
const readJSON=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
test('production catalog exports every reviewed case, and keeps full prompts out of the initial index',async()=>{
 const index=await readJSON('../dist/website/website/index.json');const source=await readJSON('../site/public-catalog.json');
 assert.equal(index.packs.length,source.themes.length);
 for(const p of index.packs){
  const original=source.themes.find(t=>t.id===p.id);assert.equal(p.downloadUrl,original.downloadUrl);assert.equal(p.sha256,original.sha256);
  const details=await readJSON('../dist/website/'+p.detailsUrl);
  assert.equal(details.length,p.entries.length);assert.ok(p.entries.every(e=>!Object.hasOwn(e,'text')));
  assert.ok(details.every(e=>typeof e.text==='string'));assert.ok(p.entries.every(e=>!e.previewImageUrl.startsWith(legacy)));
 }
});
test('English metadata covers the current catalog, including newly replaced Skills',async()=>{
 const t=await readJSON('../web/catalog-translations-en.json');const c=await readJSON('../site/public-catalog.json');const s=await readJSON('../site/skills-catalog.json');
 for(const p of c.themes)assert.ok(t.packs[p.id]?.title,p.id);
 for(const skill of s.skills)assert.ok(t.skills[skill.skillId]?.summary,skill.id);
});

import vm from 'node:vm';
test('a Skill package version update keeps its English display metadata and original download identity',async()=>{
 const context=vm.createContext({URL,Map,Set,document:{currentScript:{src:'https://promptdirector.cn/website-data.js'}},catalogEnglish:{packs:{},skills:{method:{title:'Method',summary:'Complete method'}},labels:{}}});
 vm.runInContext(await readFile(new URL('../web/website-data.js',import.meta.url),'utf8'),context);
 const metadata={skills:[{skillId:'method',id:'method@1.0.2',title:'方法',summary:'完整方法',downloadUrl:'https://example.com/method-1.0.2.zip'}]};
 context.metadata=metadata;vm.runInContext('localizeCatalogs({packs:[]},metadata)',context);
 assert.equal(metadata.skills[0].title,'Method');assert.equal(metadata.skills[0].summary,'Complete method');
 assert.equal(metadata.skills[0].id,'method@1.0.2');assert.equal(metadata.skills[0].downloadUrl,'https://example.com/method-1.0.2.zip');
});
test('detail reads share in-flight requests and a failure can be retried',async()=>{
 let calls=0;const context=vm.createContext({URL,Map,Set,document:{currentScript:{src:'https://promptdirector.cn/website-data.js'}},fetch:async()=>{calls++;if(calls===1)throw Error('network');return {ok:true,json:async()=>({id:'case',text:'complete'})}}});
 vm.runInContext(await readFile(new URL('../web/website-data.js',import.meta.url),'utf8'),context);
 await assert.rejects(vm.runInContext("readCase({detailsUrl:'website/details/p.json'},'case')",context),/network/);
 const [a,b]=await vm.runInContext("Promise.all([readCase({detailsUrl:'website/details/p.json'},'case'),readCase({detailsUrl:'website/details/p.json'},'case')])",context);
 assert.equal(calls,2);assert.equal(a.text,'complete');assert.equal(b.text,'complete');
});
test('following import merges without losing current authors and rejects unrelated JSON',async()=>{
 const key='promptdirector.curated.following.v1';const values=new Map([[key,'["existing"]']]);const status={textContent:''},input={value:'file'};const nodes={'#transfer-status':status,'#export-following':{},'#import-following':input};
 const context=vm.createContext({document:{documentElement:{lang:'en'},querySelector:s=>nodes[s]},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},Set,JSON});
 vm.runInContext(await readFile(new URL('../site/following-transfer.js',import.meta.url),'utf8'),context);
 await input.onchange({target:{files:[{text:async()=>JSON.stringify({format:'promptdirector-following',version:1,authors:['new','existing'],language:'en'})}],value:'file'}});
 assert.deepEqual(JSON.parse(values.get(key)),['existing','new']);assert.match(status.textContent,/preserved/);
 await input.onchange({target:{files:[{text:async()=>'{}'}],value:'file'}});assert.deepEqual(JSON.parse(values.get(key)),['existing','new']);assert.match(status.textContent,/Could not import/);
});

import {parseHTML} from 'linkedom';
import {access} from 'node:fs/promises';
const builtDocument=async path=>parseHTML(await readFile(new URL('../dist/website/'+path,import.meta.url),'utf8')).document;
test('the first screen is usable HTML before the catalog request, with lightweight images and crawlable case links',async()=>{
 const doc=await builtDocument('index.html');assert.ok(doc.querySelector('#app[data-prerendered]'));
 assert.equal(doc.querySelectorAll('#grid a[data-case]').length,48);assert.equal(doc.querySelector('#app .loading'),null);
 const hero=doc.querySelector('.cinema img');assert.equal(hero.getAttribute('fetchpriority'),'high');assert.match(hero.getAttribute('src'),/^\/website\/thumbs\//);
 for(const link of doc.querySelectorAll('#grid a[data-case]')){assert.match(link.href,/^\/cases\//);await access(new URL('../dist/website'+decodeURIComponent(link.href)+'index.html',import.meta.url));}
 assert.equal(doc.querySelector('footer a[href="following.html"]'),null);assert.equal(doc.querySelector('footer a[href="guide.html"]'),null);
 assert.ok(doc.querySelector('header a[href="guide.html"]'));assert.ok(doc.querySelector('footer a[href="privacy.html"]'));
});
test('bilingual canonical case pages retain the full reviewed prompt and source while old data stays separate',async()=>{
 const index=await readJSON('../dist/website/website/index.json');
 const pack=index.packs.find(p=>p.caseCounts.video),details=await readJSON('../dist/website/'+pack.detailsUrl),entry=details.find(e=>e.text?.length>100);
 for(const prefix of ['', 'en/']){
  const path=prefix+'cases/'+encodeURIComponent(pack.packageId)+'/'+encodeURIComponent(entry.id)+'/';
  const doc=await builtDocument(path+'index.html');
  assert.equal(doc.querySelector('link[rel="canonical"]').href,'https://promptdirector.cn/'+path);
  assert.equal(doc.querySelector('link[hreflang="en"]').href,'https://promptdirector.cn/en/'+path.replace(/^en\//,''));
  assert.equal(doc.querySelector('base').getAttribute('href'),prefix?'/en/':'/');
  assert.equal(JSON.parse(doc.querySelector('#initial-case-data').textContent).entry.text,entry.text);
  const first=entry.media?.[0]||entry;assert.equal(doc.querySelector('#prompt').textContent,first.text??entry.text);
  assert.equal(doc.querySelector('#caseSource').href,first.sourceUrl||entry.sourceUrl||'');
  assert.equal(doc.querySelectorAll('.standalone-detail h1').length,1);
 }
});
test('the sitemap discovers every stable case page in both languages without query duplicates',async()=>{
 const index=await readJSON('../dist/website/website/index.json');const sitemap=await readFile(new URL('../dist/website/sitemap.xml',import.meta.url),'utf8');
 const locations=[...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>m[1]);assert.equal(new Set(locations).size,locations.length);
 for(const p of index.packs)for(const e of p.entries)for(const prefix of ['', 'en/'])assert.ok(locations.includes(`https://promptdirector.cn/${prefix}cases/${encodeURIComponent(p.packageId)}/${encodeURIComponent(e.id)}/`),e.id);
 assert.ok(locations.includes('https://promptdirector.cn/privacy'));assert.ok(locations.every(u=>!u.includes('?')));
});
test('responsive card previews do not replace original media and download identities',async()=>{
 const index=await readJSON('../dist/website/website/index.json');
 for(const p of index.packs){const details=await readJSON('../dist/website/'+p.detailsUrl);for(const e of p.entries){assert.ok(e.thumbnails.length>0);assert.equal(e.previewImageUrl,details.find(d=>d.id===e.id).previewImageUrl);assert.ok(e.thumbnails.every(t=>t.width<=768));}}
});
test('both stable paths and existing shared query links resolve to the same catalog identities',async()=>{
 const index=await readJSON('../dist/website/website/index.json'),metadata=await readJSON('../dist/website/website/site.json'),p=index.packs[0],e=p.entries[0];
 const context=vm.createContext({URL,Map,Set,document:{currentScript:{src:'https://promptdirector.cn/website-data.js'},documentElement:{lang:'en'}},data:index,siteData:metadata});
 vm.runInContext(await readFile(new URL('../web/website-data.js',import.meta.url),'utf8'),context);
 context.location=new URL(`https://promptdirector.cn/en/cases/${encodeURIComponent(p.packageId)}/${encodeURIComponent(e.id)}/`);
 assert.equal(vm.runInContext('pageRoute().case',context),e.key);
 context.location=new URL('https://promptdirector.cn/en/?case='+encodeURIComponent(e.key));assert.equal(vm.runInContext('pageRoute().case',context),e.key);
});

import {addMetadata} from '../tools/website-render.mjs';
test('case titles cannot break out of structured data into executable markup',()=>{
 const document=parseHTML('<!doctype html><html><head><title></title></head><body></body></html>').document;
 const title='</script><script id="untrusted">alert(1)</script>';
 addMetadata(document,{title,description:title,url:'https://promptdirector.cn/cases/p/id/',entry:{title},english:false,config:{origin:'https://promptdirector.cn'}});
 const parsed=parseHTML(document.toString()).document;
 assert.equal(parsed.querySelector('#untrusted'),null);assert.equal(parsed.querySelectorAll('script').length,1);
 assert.equal(JSON.parse(parsed.querySelector('script').textContent).name,title);
});

test('download sorting starts with the same verified snapshot without a second render or invented zeroes',async()=>{
 const metadata=await readJSON('../dist/website/website/site.json');assert.deepEqual(metadata.metrics,await readJSON('../site/metrics.json'));
 const doc=await builtDocument('collections/index.html');assert.equal(doc.querySelector('#sort option[value="downloads"]').hasAttribute('disabled'),false);
 assert.doesNotMatch(doc.querySelector('#collection-grid').textContent,/(?:^|[^0-9])0 次整包下载/);
});

test('a visitor can search and choose a media filter while the prerendered page waits for a slow catalog',async()=>{
 const window=parseHTML(await readFile(new URL('../dist/website/index.html',import.meta.url),'utf8')),document=window.document;
 Object.defineProperty(document,'currentScript',{value:{src:'https://promptdirector.cn/website-data.js'}});
 const dialog=document.querySelector('#detail');dialog.close=()=>{dialog.open=false};dialog.showModal=()=>{dialog.open=true};
 const index=await readJSON('../dist/website/website/index.json'),metadata=await readJSON('../dist/website/website/site.json');
 const entry=index.packs.flatMap(p=>p.entries).find(e=>e.mediaKind==='video');let release;const gate=new Promise(r=>release=r);
 const context=vm.createContext({document,URL,URLSearchParams,Map,Set,innerWidth:390,location:new URL('https://promptdirector.cn/'),localStorage:{getItem:()=>null,setItem(){}},history:{replaceState(){},pushState(){}},addEventListener(){},window:{scrollTo(){}},setTimeout:()=>0,clearTimeout(){},fetch:async url=>{await gate;return{ok:true,json:async()=>structuredClone(url.endsWith('/search.json')?[[entry.key,'pending search phrase']]:url.endsWith('/index.json')?index:metadata)}}});
 for(const file of ['website-data','app'])vm.runInContext(await readFile(new URL('../web/'+file+'.js',import.meta.url),'utf8'),context);
 const started=vm.runInContext(await readFile(new URL('../web/site-pages.js',import.meta.url),'utf8'),context);
 document.querySelector('[data-kind="video"]').dispatchEvent(new window.Event('click',{bubbles:true}));
 const input=document.querySelector('[aria-label="搜索案例"]');input.value='pending search phrase';input.dispatchEvent(new window.Event('input',{bubbles:true}));
 assert.ok(document.querySelector('.cinema'));assert.match(document.querySelector('#toast').textContent,/正在读取/);
 release();await started;await vm.runInContext('searchPromise',context);
 assert.equal(document.querySelectorAll('#grid [data-case]').length,1);assert.equal(document.querySelector('#grid [data-case]').dataset.case,entry.key);
 assert.equal(document.querySelector('[data-kind="video"]').getAttribute('aria-pressed'),'true');
 assert.equal(document.querySelector('[aria-label="搜索案例"]').value,'pending search phrase');
});

test('a video started from a direct case page keeps its player when the delayed catalog becomes ready',async()=>{
 const previews=await readJSON('../web/video-previews.json');
 const index=await readJSON('../dist/website/website/index.json'),metadata=await readJSON('../dist/website/website/site.json'),pack=index.packs.find(p=>p.entries.some(e=>previews.entries[e.videoSha256])),entry=pack.entries.find(e=>previews.entries[e.videoSha256]);
 const path=`cases/${encodeURIComponent(pack.packageId)}/${encodeURIComponent(entry.id)}/`;
 const window=parseHTML(await readFile(new URL('../dist/website/'+path+'index.html',import.meta.url),'utf8')),document=window.document;
 Object.defineProperty(document,'currentScript',{value:{src:'https://promptdirector.cn/website-data.js'}});
 const dialog=document.querySelector('#detail');dialog.close=()=>{dialog.open=false};
 const player=document.querySelector('#media-content video');assert.ok(player);player.currentTime=5;
 let release;const gate=new Promise(r=>release=r);
 const context=vm.createContext({document,URL,URLSearchParams,Map,Set,innerWidth:390,location:new URL('https://promptdirector.cn/'+path),localStorage:{getItem:()=>null},history:{replaceState(){},pushState(){}},addEventListener(){},window:{scrollTo(){}},setTimeout:()=>0,clearTimeout(){},fetch:async url=>{await gate;return{ok:true,json:async()=>structuredClone(url.endsWith('/index.json')?index:metadata)}}});
 for(const file of ['website-data','app'])vm.runInContext(await readFile(new URL('../web/'+file+'.js',import.meta.url),'utf8'),context);
 const started=vm.runInContext(await readFile(new URL('../web/site-pages.js',import.meta.url),'utf8'),context);
 const quality=document.querySelector('#videoQuality');assert.ok(quality);player.load=()=>{};player.paused=true;
 Object.defineProperty(quality,'value',{value:'original'});quality.dispatchEvent(new window.Event('change',{bubbles:true}));
 assert.doesNotMatch(player.getAttribute('src'),/quality=preview/,'quality must work while the unrelated catalog is still unavailable');
 release();await started;await vm.runInContext('renderPending',context);
 assert.ok(document.querySelector('#media-content video')===player,'catalog readiness must preserve the existing player');assert.equal(player.currentTime,5);
 assert.equal(document.querySelector('.media-error'),null);
});


test('opening one case downloads only that case, not unrelated prompts from its collection',async()=>{
 const requests=[];
 const context=vm.createContext({URL,Map,Set,document:{currentScript:{src:'https://promptdirector.cn/website-data.js'}},fetch:async url=>{
  requests.push(url);const entry={id:'case',text:'complete original',media:[{text:'member original'}]};return {ok:true,json:async()=>url.endsWith('/p.json')?[entry]:entry};
 }});
 vm.runInContext(await readFile(new URL('../web/website-data.js',import.meta.url),'utf8'),context);
 const entry=await vm.runInContext("readCase({detailsUrl:'website/details/p.json'},'case')",context);
 assert.equal(requests[0],'https://promptdirector.cn/website/details/p/case.json');
 assert.equal(entry.text,'complete original');assert.equal(entry.media[0].text,'member original');
});

test('catalog readiness and media filters preserve the already visible hero image',async()=>{
 const index=await readJSON('../dist/website/website/index.json'),metadata=await readJSON('../dist/website/website/site.json');
 const window=parseHTML(await readFile(new URL('../dist/website/index.html',import.meta.url),'utf8')),document=window.document;
 Object.defineProperty(document,'currentScript',{value:{src:'https://promptdirector.cn/website-data.js'}});
 const dialog=document.querySelector('#detail');dialog.close=()=>{dialog.open=false};
 const hero=document.querySelector('.cinema img');
 const context=vm.createContext({document,URL,URLSearchParams,Map,Set,innerWidth:1440,location:new URL('https://promptdirector.cn/'),localStorage:{getItem:()=>null},history:{replaceState(){},pushState(){}},addEventListener(){},window:{scrollTo(){}},setTimeout:()=>0,clearTimeout(){},fetch:async url=>({ok:true,json:async()=>structuredClone(url.endsWith('/index.json')?index:metadata)})});
 for(const file of ['website-data','app'])vm.runInContext(await readFile(new URL('../web/'+file+'.js',import.meta.url),'utf8'),context);
 await vm.runInContext(await readFile(new URL('../web/site-pages.js',import.meta.url),'utf8'),context);
 assert.ok(document.querySelector('.cinema img')===hero,'catalog must not discard the displayed hero');
 document.querySelector('[data-kind="video"]').dispatchEvent(new window.Event('click',{bubbles:true}));
 assert.ok(document.querySelector('.cinema img')===hero,'filtering cards must not reload the hero');
});


test('each lazy case response retains every original field including compound members',async()=>{
 const index=await readJSON('../dist/website/website/index.json');
 for(const pack of index.packs){
  const entries=await readJSON('../dist/website/'+pack.detailsUrl);
  for(const entry of entries){
   const path=pack.detailsUrl.replace(/\.json$/,'/'+encodeURIComponent(entry.id)+'.json');
   assert.deepEqual(await readJSON('../dist/website/'+path),entry);
  }
 }
});

test('guide preview compression preserves source pixels, dimensions and original screenshot links in both languages',async()=>{
 const sharp=(await import('sharp')).default;
 for(const dir of ['', 'en/']){
  const source=await readFile(new URL('../site/'+dir+'guide-assets/library.png',import.meta.url));
  const doc=await builtDocument(dir+'guide.html'),img=doc.querySelector('img[src$="lossless.webp"]'),preview=img.getAttribute('src');
  assert.match(preview,/lossless\.webp$/);
  const result=await readFile(new URL('../dist/website'+preview,import.meta.url));
  assert.ok(result.length<source.length);
  assert.ok((await sharp(result).ensureAlpha().raw().toBuffer()).equals(await sharp(source).ensureAlpha().raw().toBuffer()),'decoded screenshot pixels must remain identical');
  assert.ok(doc.querySelector('a[href="guide-assets/library.png"]'));
 }
});

test('the browser discovers the exact responsive hero source before the inline stylesheet',async()=>{
 for(const dir of ['', 'en/']){
  const html=await readFile(new URL('../dist/website/'+dir+'index.html',import.meta.url),'utf8'),doc=parseHTML(html).document;
  const preload=doc.querySelector('link[rel="preload"][as="image"]'),hero=doc.querySelector('.cinema img');
  assert.ok(preload);assert.equal(preload.getAttribute('href'),hero.getAttribute('src'));
  assert.equal(preload.getAttribute('imagesrcset'),hero.getAttribute('srcset'));
  assert.equal(preload.getAttribute('imagesizes'),hero.getAttribute('sizes'));
  assert.ok(html.indexOf('rel="preload"')<html.indexOf('<style>'));
 }
});

async function pendingBrowsePage({failNextDetail=false,withoutFirstDetail=false}={}){
 const window=parseHTML(await readFile(new URL('../dist/website/index.html',import.meta.url),'utf8')),document=window.document;
 Object.defineProperty(document,'currentScript',{value:{src:'https://preview.example/website-data.js'}});
 if(withoutFirstDetail){const node=document.querySelector('#initial-browse-data'),boot=JSON.parse(node.textContent);delete boot.details?.[document.querySelector('#grid [data-case]').dataset.case];node.textContent=JSON.stringify(boot);}
 const dialog=document.querySelector('#detail');dialog.close=()=>{dialog.open=false};dialog.showModal=()=>{dialog.open=true};
 const index=await readJSON('../dist/website/website/index.json'),metadata=await readJSON('../dist/website/website/site.json');
 let releaseCatalog,releaseDetail;const catalogGate=new Promise(r=>releaseCatalog=r),detailGate=new Promise(r=>releaseDetail=r),requests=[];
 const location=new URL('https://preview.example/');
 const context=vm.createContext({document,URL,URLSearchParams,Map,Set,innerWidth:1440,location,localStorage:{getItem:()=>null,setItem(){}},history:{replaceState(_,__,u){location.href=String(u)},pushState(_,__,u){location.href=String(u)}},addEventListener(){},window:{scrollTo(){}},setTimeout:()=>0,clearTimeout(){},fetch:async url=>{
  requests.push(url);const path=new URL(url).pathname;
  if(path.includes('/details/')){if(failNextDetail){failNextDetail=false;return {ok:false,status:503}}await detailGate;return {ok:true,json:async()=>readJSON('../dist/website'+decodeURIComponent(path))}}
  await catalogGate;return {ok:true,json:async()=>structuredClone(path.endsWith('/index.json')?index:metadata)};
 }});
 for(const file of ['website-data','app'])vm.runInContext(await readFile(new URL('../web/'+file+'.js',import.meta.url),'utf8'),context);
 const started=vm.runInContext(await readFile(new URL('../web/site-pages.js',import.meta.url),'utf8'),context);
 return {window,document,dialog,context,requests,started,releaseCatalog,releaseDetail};
}

test('a visible case opens immediately even when the full catalog never arrives',async()=>{
 const h=await pendingBrowsePage({withoutFirstDetail:true}),card=h.document.querySelector('#grid [data-case]');
 Object.defineProperty(card.querySelector('img'),'currentSrc',{value:'https://preview.example/already-loaded.webp'});
 card.dispatchEvent(new h.window.Event('click',{bubbles:true,cancelable:true}));
 assert.equal(h.dialog.open,true,'slow catalog must not block opening a visible case');
 assert.ok(h.document.querySelector('#detailBody h2'));
 assert.equal(h.document.querySelector('#detailBody #media-content img').getAttribute('src'),'https://preview.example/already-loaded.webp','reuse the exact responsive image already shown on the card');
 assert.match(h.document.querySelector('#prompt').textContent,/正在读取完整案例/);
 assert.equal(h.document.querySelector('#copyPrompt').disabled,true,'loading text must not be copied as the original prompt');
 h.document.querySelector('#close').dispatchEvent(new h.window.Event('click',{bubbles:true}));
 assert.equal(h.dialog.open,false,'close must work before the catalog is ready');
});

test('the featured cover has complete original text without an extra network request',async()=>{
 const h=await pendingBrowsePage(),hero=h.document.querySelector('.feature-name');
 const opened=vm.runInContext(`openCase(${JSON.stringify(hero.dataset.case)})`,h.context);await opened;
 assert.equal(h.dialog.open,true);assert.ok(h.document.querySelector('#prompt').textContent.length>100);
 assert.doesNotMatch(h.document.querySelector('#prompt').textContent,/正在读取/);
 assert.equal(h.requests.filter(url=>url.includes('/details/')).length,0);
});

test('a video can recover through its original source when the free redirect service fails',async()=>{
 const h=await pendingBrowsePage(),card=h.document.querySelector('#grid [data-case]');
 await vm.runInContext(`openCase(${JSON.stringify(card.dataset.case)})`,h.context);
 const player=h.document.querySelector('#media-content video');let loaded=0;player.load=()=>loaded++;
 assert.match(player.getAttribute('src'),/^\/website\/video\/[a-f0-9]{64}\.mp4$/);
 player.dispatchEvent(new h.window.Event('error'));
 assert.match(player.getAttribute('src'),/^https:\/\/github.com\//);assert.equal(loaded,1);
 assert.equal(h.document.querySelector('.media-error'),null);
 player.dispatchEvent(new h.window.Event('error'));
 assert.ok(h.document.querySelector('.media-error button'));
});

test('catalog arrival preserves a case already opened and its pending detail request',async()=>{
 const h=await pendingBrowsePage({withoutFirstDetail:true}),card=h.document.querySelector('#grid [data-case]'),key=card.dataset.case;
 const opened=vm.runInContext(`openCase(${JSON.stringify(key)})`,h.context);
 assert.equal(h.dialog.open,true);
 const body=h.document.querySelector('#detailBody');const preview=body.querySelector('img');
 h.releaseCatalog();await h.started;
 assert.equal(h.dialog.open,true);assert.equal(vm.runInContext('selected.key',h.context),key);
 assert.ok(body.querySelector('img')===preview,'background index must not rebuild the active detail');
 h.releaseDetail();await opened;
 assert.ok(h.document.querySelector('#prompt').textContent.length>100);
 assert.equal(h.requests.filter(url=>url.includes('/details/')).length,1);
 assert.ok(h.requests.every(url=>url.startsWith('https://preview.example/')),'preview deployments must not fetch production-host data');
});

test('initial browse data includes full original content for every rendered case and no hidden cases',async()=>{
 const doc=await builtDocument('index.html'),initial=doc.querySelector('#initial-browse-data');assert.ok(initial);
 const boot=JSON.parse(initial.textContent),keys=[...new Set([...doc.querySelectorAll('[data-case]')].map(e=>e.dataset.case))];
 const entries=boot.packs.flatMap(p=>p.entries);assert.deepEqual(entries.map(e=>e.key).sort(),keys.sort());
 assert.deepEqual(Object.keys(boot.details).sort(),keys.sort());
 for(const pack of boot.packs)for(const entry of pack.entries)assert.deepEqual(boot.details[entry.key],await readJSON('../dist/website/'+pack.detailsUrl.replace(/\.json$/,'/'+entry.id+'.json')));
});

test('a failed case can retry without waiting for the catalog or discarding its preview',async()=>{
 const h=await pendingBrowsePage({failNextDetail:true,withoutFirstDetail:true}),key=h.document.querySelector('#grid [data-case]').dataset.case;
 await vm.runInContext(`openCase(${JSON.stringify(key)})`,h.context);
 assert.ok(h.document.querySelector('#media-content img'));assert.ok(h.document.querySelector('#retryCase'));
 h.document.querySelector('#retryCase').dispatchEvent(new h.window.Event('click',{bubbles:true}));
 assert.equal(h.document.querySelector('#toast').textContent,'','retry must not claim to wait for the unrelated catalog');
 h.releaseDetail();
 await vm.runInContext(`readCase(findCase(${JSON.stringify(key)}).pack,findCase(${JSON.stringify(key)}).id)`,h.context);
 assert.equal(h.document.querySelector('#retryCase'),null);assert.ok(h.document.querySelector('#prompt').textContent.length>100);
 assert.equal(h.document.querySelector('#copyPrompt').disabled,false);
});

test('a rendered ordinary case reveals its full prompt and starts media without waiting for any JSON',async()=>{
 const h=await pendingBrowsePage(),card=h.document.querySelector('#grid [data-case]');
 card.dispatchEvent(new h.window.Event('click',{bubbles:true,cancelable:true}));
 await Promise.resolve();await Promise.resolve();
 assert.doesNotMatch(h.document.querySelector('#prompt').textContent,/正在读取/,'a visible case must already have its original prompt');
 assert.ok(h.document.querySelector('#prompt').textContent.length>100);
 assert.ok(h.document.querySelector('#media-content video[src]'),'video connection must start independently of catalog/detail fetches');
 assert.equal(h.document.querySelector('#copyPrompt').disabled,false);
 assert.equal(h.requests.filter(url=>url.includes('/details/')).length,0);
});

test('website quality switching preserves the original, playback position and pause state',async()=>{
 const h=await pendingBrowsePage(),key=h.document.querySelector('#grid [data-case]').dataset.case;
 vm.runInContext(`previewVideos.add(findCase(${JSON.stringify(key)}).videoSha256)`,h.context);
 await vm.runInContext(`openCase(${JSON.stringify(key)})`,h.context);
 const player=h.document.querySelector('#media-content video'),quality=h.document.querySelector('#videoQuality');
 assert.ok(quality);assert.match(player.getAttribute('src'),/\?quality=preview$/);
 const original=vm.runInContext('selected.videoUrl',h.context);let played=0;player.load=()=>{};player.play=()=>{played++;return Promise.resolve()};
 player.currentTime=5;player.duration=15;player.paused=false;
 Object.defineProperty(quality,'value',{value:'original',writable:true});quality.dispatchEvent(new h.window.Event('change',{bubbles:true}));
 assert.doesNotMatch(player.getAttribute('src'),/quality=preview/);
 player.dispatchEvent(new h.window.Event('loadedmetadata'));assert.equal(player.currentTime,5);assert.equal(played,1);
 player.paused=true;quality.value='preview';quality.dispatchEvent(new h.window.Event('change',{bubbles:true}));player.dispatchEvent(new h.window.Event('loadedmetadata'));
 assert.match(player.getAttribute('src'),/quality=preview/);assert.equal(played,1,'switching a paused video must not autoplay');
 assert.equal(vm.runInContext('selected.videoUrl',h.context),original,'website preview must never overwrite original media identity');
});

test('returning visitors load scripts matching the new page instead of four-hour cached code',async()=>{
 const {createHash}=await import('node:crypto');
 for(const path of ['index.html','en/index.html']){
  const {document}=parseHTML(await readFile(new URL('../dist/website/'+path,import.meta.url),'utf8'));
  const base=new URL(path,'https://promptdirector.cn/');
  for(const node of document.querySelectorAll('script[src],link[rel="stylesheet"]')){
   const url=new URL(node.getAttribute('src')||node.getAttribute('href'),base);
   if(url.origin!==base.origin)continue;
   const content=await readFile(new URL('../dist/website'+url.pathname,import.meta.url));
   assert.equal(url.searchParams.get('v'),createHash('sha1').update(content).digest('hex'),url.pathname);
  }
 }
});
