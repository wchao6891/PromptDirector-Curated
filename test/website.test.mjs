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
 let calls=0;const context=vm.createContext({URL,Map,Set,document:{currentScript:{src:'https://promptdirector.cn/website-data.js'}},fetch:async()=>{calls++;if(calls===1)throw Error('network');return {ok:true,json:async()=>[{id:'case',text:'complete'}]}}});
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
