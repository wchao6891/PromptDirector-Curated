// Website-only playback derivatives. Never writes site/, originals or download packages.
import {readFile,writeFile,mkdir,rename,unlink,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,join} from 'node:path';
const exec=promisify(execFile),args=Object.fromEntries(process.argv.slice(2).map(x=>x.replace(/^--/,'').split('=')));
if(!args.output||!args['release-base'])throw Error('Use --output=DIR --release-base=URL [--encoder=libx264] [--only=SOURCE_SHA]');
const out=resolve(args.output),root=resolve(import.meta.dirname,'..');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const profile=await json(join(root,'web/video-profile.json'));
const index=await json(join(root,'dist/website/website/index.json'));
const sources=new Map();
for(const pack of index.packs)for(const e of await json(join(root,'dist/website',pack.detailsUrl)))for(const m of e.media?.length?e.media:[e])if(m.videoUrl&&m.videoSha256)sources.set(m.videoSha256,m);
await mkdir(out,{recursive:true});
const receiptFile=join(out,'receipt.json');
let receipt;try{receipt=await json(receiptFile)}catch(e){if(e.code!=='ENOENT')throw e;receipt={profile,entries:{}};}
if(JSON.stringify(receipt.profile)!==JSON.stringify(profile))throw Error('Use a new output directory for a different playback profile');
const pending=[...sources].filter(([sha])=>(!args.only||sha===args.only)&&!receipt.entries[sha]).sort((a,b)=>(b[1].videoBytes||0)-(a[1].videoBytes||0));
const probe=async file=>JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',file])).stdout);
let writes=Promise.resolve(),completed=0;
async function convert([sha,media]){
 const original=join(out,sha+'.source.mp4'),partial=join(out,sha+'.partial.mp4'),output=join(out,sha+'-preview.mp4');
 const started=Date.now();
 await exec('curl',['-fLsS','--retry','2','--max-time','180','-o',original,media.videoUrl]);
 const input=await probe(original),video=input.streams.find(s=>s.codec_type==='video');
 if(!video||!Number.isFinite(Number(input.format.duration)))throw Error('Invalid source video '+sha);
 const [num,den]=video.avg_frame_rate.split('/').map(Number),fps=Math.min(num/den,profile.maxFrameRate);
 const originalBytes=(await stat(original)).size,duration=Number(input.format.duration);
 let record={sourceBytes:originalBytes,bytes:originalBytes,width:video.width,height:video.height,duration};
 const alreadySmooth=video.codec_name==='h264'&&Math.max(video.width,video.height)<=profile.maxEdge&&num/den<=profile.maxFrameRate&&originalBytes*8/duration<=profile.videoBitrate+profile.audioBitrate;
 if(!alreadySmooth){
 const encoder=args.encoder||'libx264';
 const options=['-hide_banner','-loglevel','error','-nostdin','-y','-i',original,'-map','0:v:0','-map','0:a:0?',
  '-vf',`scale=w='min(${profile.maxEdge},iw)':h='min(${profile.maxEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
  '-c:v',encoder,'-b:v',String(profile.videoBitrate),'-pix_fmt','yuv420p','-r',String(fps),
  ...(encoder==='libx264'?['-preset','veryfast','-threads','2']:[]),
  '-c:a','aac','-b:a',String(profile.audioBitrate),'-movflags','+faststart',partial];
 await exec('ffmpeg',options,{maxBuffer:1024*1024});
 const encoded=await probe(partial),stream=encoded.streams.find(s=>s.codec_type==='video');
 const bytes=(await stat(partial)).size;
 if(Math.abs(Number(encoded.format.duration)-Number(input.format.duration))>.25||stream.codec_name!=='h264'||stream.width>profile.maxEdge||stream.height>profile.maxEdge)throw Error('Incomplete playback derivative '+sha);
 record={sourceBytes:originalBytes,bytes,width:stream.width,height:stream.height,duration:Number(encoded.format.duration)};
 if(bytes<originalBytes){await rename(partial,output);record.url=args['release-base'].replace(/\/$/,'')+'/'+sha+'-preview.mp4';}
 else await unlink(partial); // A larger derivative gives the visitor no benefit.
 }
 record.elapsedMs=Date.now()-started;
 await unlink(original); // Only this tool's temporary downloaded copy, never a reviewed source.
 receipt.entries[sha]=record;completed++;
 writes=writes.then(()=>writeFile(receiptFile,JSON.stringify(receipt,null,2)));await writes;
 if(completed===1||completed%10===0)console.log(JSON.stringify({completed,remaining:pending.length,sourceBytes:originalBytes,previewBytes:record.bytes,elapsedMs:record.elapsedMs}));
}
const errors=[];
await Promise.all(Array.from({length:Number(args.concurrency||2)},async()=>{while(pending.length){const item=pending.shift();try{await convert(item)}catch(error){errors.push({sha:item[0],message:error.message});console.error(item[0],error.message)}}}));
await writes;
const manifest={profile,entries:Object.fromEntries(Object.entries(receipt.entries).filter(([,v])=>v.url).map(([sha,{url,bytes,width,height,duration}])=>[sha,{url,bytes,width,height,duration}]))};
await writeFile(join(out,'video-previews.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({processed:Object.keys(receipt.entries).length,previews:Object.keys(manifest.entries).length,errors}));
if(errors.length)process.exitCode=1;
