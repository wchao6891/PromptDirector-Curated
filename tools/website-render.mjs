import {parseHTML} from 'linkedom';
import vm from 'node:vm';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';

const safeJson=value=>JSON.stringify(value).replaceAll('<','\\u003c');
const summary=text=>String(text||'').replace(/\s+/g,' ').trim().slice(0,160);
const segment=value=>{if(!value||/[\\/]/.test(value)||value==='.'||value==='..')throw Error('Invalid public page identifier');return encodeURIComponent(value)};

// Reuse the actual browser templates so first paint and interactive views agree.
export async function renderWebsite({out,index,metadata,details,config}){
 const documents=[],styles=await readFile(join(out,'style.css'),'utf8');
 for(const english of [false,true]){
  const prefix=english?'en/':'',template=await readFile(join(out,prefix,'index.html'),'utf8');
  const {document}=parseHTML(template);
  Object.defineProperty(document,'currentScript',{value:{src:config.origin+'/website-data.js'}});
  const dialog=document.querySelector('#detail');dialog.close=()=>{dialog.open=false};dialog.showModal=()=>{dialog.open=true};
  const sandbox={document,URL,URLSearchParams,Map,Set,console,structuredClone,innerWidth:1440,location:new URL(config.origin+'/'+prefix),localStorage:{getItem:()=>null},history:{replaceState(){},pushState(){}},addEventListener(){},scrollTo(){},matchMedia:()=>({matches:false}),setTimeout:()=>0,clearTimeout(){},inputIndex:index,inputMetadata:metadata};
  sandbox.window=sandbox;
  sandbox.fetch=async url=>{const path=decodeURIComponent(new URL(url).pathname.slice(1));if(!details.has(path))throw Error('Unreviewed build request: '+path);return {ok:true,json:async()=>structuredClone(details.get(path))}};
  const context=vm.createContext(sandbox);
  for(const file of ['website-data.js',...(english?['catalog-en.js']:[]),english?'app-en.js':'app.js',english?'site-pages-en.js':'site-pages.js']){
   let code=await readFile(join(out,file),'utf8');code=code.replace(/startWebsite\(\);\s*$/,'');vm.runInContext(code,context,{filename:file});
  }
  vm.runInContext('data=resolveMedia(structuredClone(inputIndex));siteData=resolveMedia(structuredClone(inputMetadata));localizeCatalogs(data,siteData);data.packs.forEach(p=>p.entries.forEach((e,i)=>{e.pack=p;e.entryOrder=i;all.push(e)}));',context);
  const defaultDescription=english?'Spot it. Save it. Explore curated visual references, complete prompts and creative Skills with PromptDirector, the free, open-source Chrome extension.':'Spot it. Save it. 刷到就存，要用就有。浏览精选视觉案例、完整提示词与创作 Skill。PromptDirector 是永久免费、持续开源的创作灵感采集插件。';
  const hero=vm.runInContext('all.find(e=>e.pack.id===data.featuredCase.pack&&e.id===data.featuredCase.entry)||all[0]',context);
  const routes=[{path:'',image:hero.previewImageUrl,title:'PromptDirector · Spot it. Save it.',description:defaultDescription},
   ...[['collections',english?'Curated collections':'精选合集'],['skills',english?'Creative Skills':'精选 Skill'],['about',english?'About PromptDirector':'关于 PromptDirector'],['submit',english?'Share your work':'分享投稿']].map(([path,title])=>({path:path+'/',title:title+' · PromptDirector',description:defaultDescription}))];
  const localized=vm.runInContext('({packs:data.packs,skills:siteData.skills})',context);
  for(const p of localized.packs){
   routes.push({path:`collections/${segment(p.packageId)}/`,title:p.title+' · PromptDirector',description:summary(p.summary)||`${p.caseCount} ${english?'visual references with complete prompts and sources.':'个精选案例，查看完整提示词与来源，也可整包下载。'}`,image:p.entries[0]?.previewImageUrl});
   for(const e of p.entries)routes.push({path:`cases/${segment(p.packageId)}/${segment(e.id)}/`,title:summary(e.title).slice(0,90)+' · PromptDirector',description:summary(e.title)+' · '+p.title,image:e.previewImageUrl,entry:e,pack:p});
  }
  for(const s of localized.skills)routes.push({path:`skills/${segment(s.skillId)}/`,title:s.title+' · PromptDirector',description:summary(s.summary),image:s.cover?.path});
  for(const p of new Map([...localized.packs,...localized.skills].map(p=>[p.authorId,p])).values())routes.push({path:`authors/${segment(p.authorId)}/`,title:p.author+' · PromptDirector',description:english?'Explore collections and creative Skills shared by '+p.author:'浏览 '+p.author+' 分享的精选合集与创作 Skill。'});
  for(const route of routes){
   context.location=new URL(config.origin+'/'+prefix+route.path);
   document.querySelector('#initial-case-data')?.remove();
   vm.runInContext('restoreRoute()',context);await vm.runInContext('renderPending',context);
   const main=document.querySelector('#app');main.dataset.prerendered='true';
   if(main.querySelector('.loading')||(route.entry&&!main.querySelector('.standalone-case #prompt')))throw Error('Incomplete prerender: '+route.path);
   if(route.entry){
    const raw=details.get(route.pack.detailsUrl.replace(config.origin+'/','')).find(e=>e.id===route.entry.id);
    if(!raw)throw Error('Missing reviewed case: '+route.entry.id);
    const script=document.createElement('script');script.id='initial-case-data';script.type='application/json';script.textContent=safeJson({pack:route.pack.id,entry:raw});document.body.append(script);
   }
   const page=parseHTML(document.toString()).document;
   if(!route.path){
    const link=page.querySelector('link[rel="stylesheet"]'),style=page.createElement('style');style.textContent=styles;link.replaceWith(style);
    const heroImage=page.querySelector('.cinema img'),preload=page.createElement('link');
    for(const [name,value] of Object.entries({rel:'preload',as:'image',href:heroImage.getAttribute('src'),imagesrcset:heroImage.getAttribute('srcset'),imagesizes:heroImage.getAttribute('sizes'),fetchpriority:'high'}))if(value)preload.setAttribute(name,value);
    page.head.prepend(preload);
   }
   // Local assets remain on the current host, including preview deployments.
   for(const node of page.querySelectorAll('[src],[href],[srcset],[imagesrcset]'))for(const attr of ['src','href','srcset','imagesrcset'])if(node.hasAttribute(attr))node.setAttribute(attr,node.getAttribute(attr).replaceAll(config.origin+'/', '/'));
   page.querySelector('.language-link').setAttribute('href','/'+(english?'':'en/')+route.path);
   const url=config.origin+'/'+prefix+route.path;
   addMetadata(page,{...route,url,english,config,description:route.description||defaultDescription});
   const directory=join(out,prefix,decodeURIComponent(route.path));
   await mkdir(directory,{recursive:true});await writeFile(join(directory,'index.html'),'<!doctype html>'+page.documentElement.outerHTML);
   documents.push(url);
  }
 }
 return documents;
}

export function addMetadata(document,{title,description,url,image,english,config,entry}){
 document.title=title;document.querySelector('meta[name="description"]')?.remove();
 for(const node of document.querySelectorAll('[data-page-meta]'))node.remove();
 const append=(tag,attributes)=>{const node=document.createElement(tag);node.dataset.pageMeta='';for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);document.head.append(node);return node};
 append('meta',{name:'description',content:description});
 append('link',{rel:'canonical',href:url});
 const relative=url.slice(config.origin.length).replace(/^\/en\//,'/');
 for(const [lang,href] of [['zh-CN',config.origin+relative],['en',config.origin+'/en'+relative],['x-default',config.origin+relative]])append('link',{rel:'alternate',hreflang:lang,href});
 const shareImage=image?new URL(image,config.origin+'/').href:null;
 for(const [property,content] of Object.entries({'og:type':entry?'article':'website','og:site_name':'PromptDirector','og:title':title,'og:description':description,'og:url':url,'og:locale':english?'en_US':'zh_CN',...(shareImage?{'og:image':shareImage}:{})}))append('meta',{property,content});
 append('meta',{name:'twitter:card',content:image?'summary_large_image':'summary'});
 const schema=entry?{'@context':'https://schema.org','@type':'CreativeWork',name:entry.title,url,image:shareImage}:url===config.origin+'/'||url===config.origin+'/en/'?{'@context':'https://schema.org','@type':'WebSite',name:'PromptDirector',url:config.origin,inLanguage:english?'en':'zh-CN',description}:null;
 if(schema){const script=append('script',{type:'application/ld+json'});script.textContent=safeJson(schema)}
}
