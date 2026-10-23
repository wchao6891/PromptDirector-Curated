import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const hash='a'.repeat(64),original='https://github.com/owner/repo/releases/download/media/'+hash+'.mp4';
const request=(path=hash+'.mp4',method='GET')=>new Request('https://preview.pages.dev/website/video/'+path,{method});
test('video starts at the actual file host without downloading or proxying the original',async()=>{
 const {createVideoWorker}=await import('../web/video-worker.js');
 const destination='https://release-assets.githubusercontent.com/asset?jwt=temporary';
 const calls=[];
 const worker=createVideoWorker({sources:{[hash]:original},previews:{}},async(url,options)=>{calls.push({url,options});return new Response(null,{status:302,headers:{location:destination}})});
 for(const method of ['GET','HEAD']){
  const result=await worker.fetch(request(undefined,method));
  assert.equal(result.status,302);assert.equal(result.headers.get('location'),destination);
  assert.equal(result.headers.get('cache-control'),'no-store');
 }
 assert.equal(calls.length,2);assert.ok(calls.every(c=>c.url===original&&c.options.method==='HEAD'&&c.options.redirect==='manual'));
});
test('the deployed helper contains only reviewed originals and static visits consume no function calls',async()=>{
 const read=async path=>JSON.parse(await readFile(new URL('../dist/website/'+path,import.meta.url),'utf8'));
 assert.deepEqual(await read('_routes.json'),{version:1,include:['/website/video/*'],exclude:[]});
 const source=await readFile(new URL('../dist/website/_worker.js',import.meta.url),'utf8');
 const deployed=JSON.parse(source.match(/export default createVideoWorker\((.*)\);/)[1]);
 const expected={};
 for(const pack of (await read('website/index.json')).packs)for(const entry of await read(pack.detailsUrl))for(const media of entry.media?.length?entry.media:[entry])if(media.videoUrl&&media.videoSha256)expected[media.videoSha256]=media.videoUrl;
 assert.deepEqual(deployed.sources,expected);assert.ok(Object.keys(expected).length>0);
 const previews=JSON.parse(await readFile(new URL('../web/video-previews.json',import.meta.url),'utf8'));
 assert.deepEqual(deployed.previews,Object.fromEntries(Object.entries(previews.entries).map(([sha,v])=>[sha,v.url])));
 const browserData=await readFile(new URL('../dist/website/website-data.js',import.meta.url),'utf8');
 const enabled=JSON.parse(browserData.match(/const previewVideos=new Set\((\[[^;]*\])\);/)[1]);
 assert.deepEqual(enabled.sort(),Object.keys(previews.entries).sort());
});
test('video routing rejects unknown assets and unsafe redirects; upstream failure preserves the original',async()=>{
 const {createVideoWorker}=await import('../web/video-worker.js');
 let calls=0;
 const worker=createVideoWorker({sources:{[hash]:original},previews:{}},async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://untrusted.example/asset'}})});
 assert.equal((await worker.fetch(request('unknown.mp4'))).status,404);
 assert.equal((await worker.fetch(request(undefined,'POST'))).status,405);assert.equal(calls,0);
 assert.equal((await worker.fetch(request())).headers.get('location'),original);
 const broken=createVideoWorker({sources:{[hash]:original},previews:{}},async()=>{throw Error('unavailable')});
 assert.equal((await broken.fetch(request())).headers.get('location'),original);
});
test('smooth playback resolves a separate derivative while original quality retains the exact original',async()=>{
 const {createVideoWorker}=await import('../web/video-worker.js');
 const preview=original.replace('/media/','/website-previews/'),seen=[];
 const worker=createVideoWorker({sources:{[hash]:original},previews:{[hash]:preview}},async url=>{seen.push(url);return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file'}})});
 await worker.fetch(request(hash+'.mp4?quality=preview'));await worker.fetch(request(hash+'.mp4?quality=original'));
 assert.deepEqual(seen,[preview,original]);
});
