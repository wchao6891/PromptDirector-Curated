import sharp from 'sharp';
import {availableParallelism} from 'node:os';
import {execFileSync} from 'node:child_process';
import {mkdir,copyFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';

// Card widths cover two-column phones and desktop columns at high pixel density.
const cardWidths=[384,768],quality=80;
export async function prepareWebsiteImages({root,source,out,index,skills}){
 const objects=new Map(execFileSync('git',['ls-files','-s','--','site'],{cwd:root,encoding:'utf8'}).trim().split('\n').map(line=>{const m=line.match(/^\d+ ([a-f0-9]+) \d+\t(.+)$/);return m?[m[2].slice(5),m[1]]:[];}));
 const dirty=new Set(execFileSync('git',['diff','--name-only','HEAD','--','site'],{cwd:root,encoding:'utf8'}).trim().split('\n').map(p=>p.slice(5)));
 const wanted=new Map();
 const add=(path,widths)=>{if(!path||/^https?:/.test(path))return;wanted.set(path,[...new Set([...(wanted.get(path)||[]),...widths])]);};
 for(const p of index.packs)for(const e of p.entries)add(e.previewImageUrl,cardWidths);
 for(const s of skills)add(s.cover?.path,cardWidths);
 const hero=index.packs.find(p=>p.id===index.featuredCase.pack)?.entries.find(e=>e.id===index.featuredCase.entry);
 if(hero)add(hero.previewImageUrl,[1280,1600]);
 const results=new Map(),dimensions=new Map(),queue=[...wanted],cache=join(root,'.cache/website-images');
 sharp.concurrency(1);
 async function worker(){while(queue.length){
  const [path,widths]=queue.shift(),input=resolve(source,path);
  if(!input.startsWith(source+'/'))throw Error('Website preview must stay inside the reviewed site');
  const sourceStat=await stat(input),meta=await sharp(input).metadata();
  const width=[5,6,7,8].includes(meta.orientation)?meta.height:meta.width;
  dimensions.set(path,{width,height:[5,6,7,8].includes(meta.orientation)?meta.width:meta.height});
  if(!width)throw Error('Cannot read preview dimensions: '+path);
  // Reuse existing Git object identities; no repeated whole-file digest pass.
  const identity=!dirty.has(path)&&objects.get(path)||`local/${path}/${sourceStat.size}-${Math.floor(sourceStat.mtimeMs)}`;
  const variants=[];
  for(const size of [...new Set(widths.map(w=>Math.min(w,width)))].sort((a,b)=>a-b)){
   const relative=`website/thumbs/${identity}/${size}-q${quality}.webp`,cached=join(cache,identity,`${size}-q${quality}.webp`);
   await mkdir(join(cache,identity),{recursive:true});
   try{await stat(cached)}catch(e){if(e.code!=='ENOENT')throw e;await sharp(input).rotate().resize({width:size,withoutEnlargement:true}).webp({quality}).toFile(cached);}
   await mkdir(join(out,'website/thumbs',identity),{recursive:true});await copyFile(cached,join(out,relative));
   variants.push({url:relative,width:size});
  }
  results.set(path,variants);
 }}
 await Promise.all(Array.from({length:Math.min(availableParallelism(),queue.length)},worker));
 for(const p of index.packs)for(const e of p.entries)e.thumbnails=results.get(e.previewImageUrl)?.filter(v=>v.width<=768);
 for(const s of skills)if(s.cover){s.cover.thumbnails=results.get(s.cover.path);Object.assign(s.cover,dimensions.get(s.cover.path));}
 index.heroImages=hero?results.get(hero.previewImageUrl)?.filter(v=>v.width>=Math.min(1280,hero.width||1280)):[];
 return results.size;
}
