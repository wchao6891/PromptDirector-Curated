// Resolve GitHub's redirect at the edge; the browser streams the unchanged original.
export function createVideoWorker(sources,fetchSource=fetch){
 return {async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(!path.startsWith('/website/video/'))return env.ASSETS.fetch(request);
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
  const hash=path.match(/^\/website\/video\/([a-f0-9]{64})\.mp4$/)?.[1];
  const original=hash&&sources[hash];
  if(!original)return new Response(null,{status:404});
  let destination=original;
  try{
   // A stalled lookup must not prevent retrying the original public source.
   const response=await fetchSource(original,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(5000)});
   if(response.status===302){
    const location=new URL(response.headers.get('location'));
    if(location.protocol==='https:'&&location.hostname==='release-assets.githubusercontent.com'&&!location.username&&!location.password)destination=location.href;
   }
  }catch{}
  // GitHub's signed file URL expires earlier than the enclosing SAS token.
  return new Response(null,{status:302,headers:{Location:destination,'Cache-Control':'no-store'}});
 }};
}
