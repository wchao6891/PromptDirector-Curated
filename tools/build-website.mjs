// One reviewed content source. site/ remains the unchanged legacy deployment.
import {readFile,writeFile,mkdir,cp,rm,readdir,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,relative,dirname,join} from 'node:path';
import {buildPackage,localAsset,mapAssetUrls} from './website-data.mjs';
import {normalizeSiteCatalog,normalizeSitePreview} from './curated-site-data.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=join(root,'site'),web=join(root,'web'),out=join(root,'dist/website');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const config=await json(join(web,'config.json')),ui=await json(join(web,'ui-en.json'));
const translations=await json(join(web,'catalog-translations-en.json'));
const catalog=await json(join(source,'public-catalog.json'));
normalizeSiteCatalog(catalog);
const skills=await json(join(source,'skills-catalog.json'));
const firstPublished=await json(join(web,'publication-dates.json'));
const missing=new Set(catalog.themes.filter(p=>!p.publishedAt&&!firstPublished[p.id]).map(p=>p.id));
// Commit history supplies evidence for old packages; editing a package never promotes it.
if(missing.size&&execFileSync('git',['rev-parse','--is-shallow-repository'],{cwd:root,encoding:'utf8'}).trim()==='true')throw Error('New packages need publishedAt or complete Git history (fetch-depth: 0).');
const commits=missing.size?execFileSync('git',['log','--reverse','--format=%H %cI','--','site/public-catalog.json'],{cwd:root,encoding:'utf8'}).trim().split('\n'):[];
for(const line of commits){
 const [sha,date]=line.split(' ');
 const historical=JSON.parse(execFileSync('git',['show',`${sha}:site/public-catalog.json`],{cwd:root,encoding:'utf8'}));
 for(const p of historical.themes)if(missing.delete(p.id))firstPublished[p.id]=date;
 if(!missing.size)break;
}
const index={version:1,featuredCase:config.featuredCase,packs:[]},search=[];
const detailOutputs=[];
for(const theme of catalog.themes){
 const path=localAsset(theme.previewUrl,config.legacyOrigin);
 if(path===theme.previewUrl||resolve(source,path).startsWith(source+'/')===false)throw Error('Preview must be in the reviewed site');
 const preview=await json(join(source,path));normalizeSitePreview(preview,theme);
 const built=buildPackage(theme,preview,theme.publishedAt||firstPublished[theme.id],config.legacyOrigin);
 index.packs.push(built.pack);search.push(...built.search);detailOutputs.push([built.pack.detailsUrl,built.details]);
}
const translate=s=>Object.entries(ui).sort((a,b)=>b[0].length-a[0].length).reduce((s,[zh,en])=>s.split(zh).join(en),s);
const bytes=s=>Buffer.byteLength(s);
await mkdir(out,{recursive:true});
// Remove only the generated output: no reviewed source assets are mutated.
await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
for(const name of ['previews','covers','reviews','media','skill-previews','skills','guide-assets','assets','lib']){
 try{await cp(join(source,name),join(out,name),{recursive:true})}catch(e){if(e.code!=='ENOENT')throw e;}
}
await mkdir(join(out,'en'),{recursive:true});
for(const name of ['guide-assets','assets'])try{await cp(join(source,'en',name),join(out,'en',name),{recursive:true})}catch(e){if(e.code!=='ENOENT')throw e;}
for(const theme of catalog.themes){const path=localAsset(theme.previewUrl,config.legacyOrigin);const value=await json(join(source,path));await writeFile(join(out,path),JSON.stringify(mapAssetUrls(value,config.legacyOrigin)).replace(/"(previewImageUrl|videoUrl)":"(?!https?:)([^"]+)"/g,(_,key,path)=>JSON.stringify(key)+':'+JSON.stringify(config.origin+'/'+path)));}
for(const name of ['catalog.json','public-catalog.json','skills-catalog.json','metrics.json']){
 // New-domain data has its own URLs; legacy files remain byte-identical in site/.
 const text=await readFile(join(source,name),'utf8');
 await writeFile(join(out,name),text.split(config.legacyOrigin).join(config.origin+'/'));
}
await cp(join(source,'following.html'),join(out,'following.html'));await cp(join(source,'en/following.html'),join(out,'en/following.html'));await cp(join(source,'following-transfer.js'),join(out,'following-transfer.js'));
for(const name of ['guide.css','guide.js','privacy.css','lang.js'])await cp(join(source,name),join(out,name));
await cp(join(web,'assets'),join(out,'assets'),{recursive:true});
await cp(join(web,'style.css'),join(out,'style.css'));
await cp(join(web,'website-data.js'),join(out,'website-data.js'));
await mkdir(join(out,'website/details'),{recursive:true});
for(const [path,value] of detailOutputs)await writeFile(join(out,path),JSON.stringify(value));
await writeFile(join(out,'website/index.json'),JSON.stringify(index));
await writeFile(join(out,'website/search.json'),JSON.stringify(search));
await writeFile(join(out,'website/site.json'),JSON.stringify({skills:skills.skills,contact:config.contact,origin:config.origin}));
await writeFile(join(out,'catalog-en.js'),'const catalogEnglish='+JSON.stringify(translations)+';\n');
for(const name of ['app','site-pages']){
 const zh=await readFile(join(web,name+'.js'),'utf8');
 await writeFile(join(out,name+'.js'),zh);
 const en=translate(zh).replaceAll("toLocaleDateString('zh-CN'","toLocaleDateString('en-US'");
 const remaining=en.match(/[\u3400-\u9fff]+/g);
 if(remaining)throw Error(`Untranslated UI in ${name}: ${[...new Set(remaining)].join(', ')}`);
 await writeFile(join(out,name+'-en.js'),en);
}
const template=await readFile(join(web,'index.html'),'utf8');
for(const english of [false,true]){
 let page=english?translate(template).replace('lang="zh-CN"','lang="en"'):template;
 if(english){
  page=page.replace('href="en/index.html" hreflang="en" data-pd-set-lang="en">EN','href="../index.html" hreflang="zh-CN" data-pd-set-lang="zh-CN">中文')
   .replace(/(src|href)="(style.css|lang.js|website-data.js|assets\/brand.svg)"/g,'$1="../$2"')
   .replace('src="app.js"','src="../app-en.js"').replace('src="site-pages.js"','src="../site-pages-en.js"')
   .replace('<script src="../app-en.js"','<script src="../catalog-en.js"></script><script src="../app-en.js"')
   .replace(/<span class="brand-tagline">.*?<\/span>/,'');
 }
 const dir=english?'en/':'';
 await writeFile(join(out,dir,'index.html'),page);
 const header=page.match(/<header>[\s\S]*?<\/header>/)[0].replace(/<button data-view="([^"]+)"[^>]*>(.*?)<\/button>/g,'<a href="index.html?view=$1">$2</a>').replace('href="#"','href="index.html"');
 const footer=page.match(/<footer[\s\S]*?<\/footer>/)[0].replace('href="#"','href="index.html"');
 for(const name of ['guide','privacy','support']){
  let doc=await readFile(join(source,dir,name+'.html'),'utf8');
  doc=doc.replace(/<header[\s\S]*?<\/header>/,header.replace(english?'../index.html" hreflang':'en/index.html" hreflang',english?`../${name}.html" hreflang`:`en/${name}.html" hreflang`));
  doc=doc.replace(/<footer[\s\S]*?<\/footer>/,footer);
  doc=doc.replace(/<link[^>]+href="(?:\.\.\/)?styles\.css"[^>]*>/g,'');
  doc=doc.replace('</head>',`<link rel="stylesheet" href="${english?'../':''}style.css"><link rel="icon" href="${english?'../':''}assets/brand.svg"></head>`);
  doc=doc.split(config.legacyOrigin).join(config.origin+'/');
  doc=doc.replaceAll('href="overview.html"','href="index.html?view=about"').replaceAll('href="skills.html"','href="index.html?view=skills"');
  await writeFile(join(out,dir,name+'.html'),doc);
 }
 // Preserve old human page links within the new site, including query and language.
 for(const [name,view] of [['skills','skills'],['overview','about']])await writeFile(join(out,dir,name+'.html'),`<!doctype html><html lang="${english?'en':'zh-CN'}"><meta charset="utf-8"><title>PromptDirector</title><a href="index.html?view=${view}">PromptDirector</a><script>const u=new URL('index.html',location);u.search=location.search;u.searchParams.set('view','${view}');u.hash=location.hash;location.replace(u.href)</script></html>`);
}
await writeFile(join(out,'robots.txt'),`User-agent: *\nAllow: /\nSitemap: ${config.origin}/sitemap.xml\n`);
await writeFile(join(out,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['','en/','guide.html','en/guide.html','privacy.html','en/privacy.html','support.html','en/support.html'].map(p=>`<url><loc>${config.origin}/${p}</loc></url>`).join('')}</urlset>`);
console.log(JSON.stringify({packages:index.packs.length,cases:index.packs.reduce((n,p)=>n+p.entries.length,0),skills:skills.skills.length,indexBytes:bytes(JSON.stringify(index)),searchBytes:bytes(JSON.stringify(search)),output:relative(root,out)}));
