// Public website: browse reviewed content without writing to the extension library.
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let siteData,onlyFollowing=false,authorId='',following=readFollowing(),skillQuery='',skillSort='newest';

let catalogLoading=true;
let data,all=[],shown=[],view='explore',kind='',query='',packId='',filterPack='',selected=null,sort='newest',limit=48,collectionQuery='',collectionLimit=12;
const app=$('#app'),dialog=$('#detail');
const label=e=>{const title=e.title.length>90?e.title.split(' on X:')[0]:e.title;return title.length>90?title.slice(0,90)+'…':title};
const image=e=>previewImage({...e,title:label(e)});
const types=()=>`<div class="types">${[['','全部'],['image','图片'],['video','视频']].map(([v,l])=>`<button class="filter ${kind===v?'active':''}" data-kind="${v}" aria-pressed="${kind===v}">${l}</button>`).join('')}</div>`;
const search=()=>`<label class="search"><span aria-hidden="true">⌕</span><input aria-label="搜索案例" placeholder="搜索作品、作者、提示词" value="${esc(query)}"></label>`;
const date=p=>Date.parse(p.publishedAt);
const downloadCount=p=>siteData.metrics?.downloads[p.id]??null;
const downloadLabel=p=>downloadCount(p)>0?downloadCount(p)+' 次整包下载':'';
const showCardAuthor=name=>!!name&&name!=='PromptDirector 编辑精选';
const orderedPacks=()=>[...data.packs].sort((a,b)=>(sort==='downloads'?downloadCount(b)-downloadCount(a):sort==='recommended'?a.order-b.order:sort==='oldest'?date(a)-date(b):date(b)-date(a))||a.order-b.order);
const mediaType=m=>m.mediaKind||m.type||(m.videoUrl?'video':'image');
const hasKind=(e,k)=>!k||(e.mediaKinds||[mediaType(e)]).includes(k);
const caseCounts=p=>p.caseCounts;
const packTypeLabel=p=>caseCounts(p).image&&caseCounts(p).video?`${caseCounts(p).image} 图片 · ${caseCounts(p).video} 视频`:caseCounts(p).video?'视频':'图片';
const dateLabel=p=>new Date(p.publishedAt).toLocaleDateString('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'});
function sortControl(){const values=[['newest','最新优先'],['recommended','编辑推荐'],['downloads',view==='collections'?'下载最多':'合集下载量'],['oldest','最早优先']];return `<label class="sort-control"><select aria-label="排序方式" id="sort">${values.map(([v,l])=>`<option value="${v}" ${v==='downloads'&&!siteData.metrics?'disabled':''} ${sort===v?'selected':''}>${l}</option>`).join('')}</select></label>`}
function followedFilter(){return `<button class="filter follow-filter ${onlyFollowing?'active':''}" id="followedOnly" aria-pressed="${onlyFollowing}">已关注</button>`}
function authorLink(p){return `<a class="author-link" href="${authorPath(p)}" title="${esc(p.author)}" data-author="${esc(p.authorId)}">${esc(p.author)}</a>`}
function followButton(p){return `<button class="follow-action" data-follow="${esc(p.authorId)}" aria-pressed="${following.has(p.authorId)}">${following.has(p.authorId)?'已关注':'关注上传者'}</button>`}
function packPicker(){return `<details class="pack-picker"><summary>${esc(data.packs.find(p=>p.id===filterPack)?.title||'所有合集')} <span>⌄</span></summary><div class="pack-menu"><input aria-label="搜索合集" placeholder="搜索合集名称或作者"><div id="pack-options"></div></div></details>`}
function renderPackOptions(q=''){if(!data)return;const el=$('#pack-options');if(!el)return;const packs=orderedPacks().filter(p=>[p.title,p.originalTitle,p.author].join(' ').toLowerCase().includes(q.toLowerCase()));el.innerHTML=`<button data-filter-pack="" class="${!filterPack?'active':''}">所有合集 <span>${data.packs.length}</span></button>`+packs.map(p=>`<button data-filter-pack="${esc(p.id)}" class="${filterPack===p.id?'active':''}"><span>${esc(p.title)}</span><small>${p.caseCount}</small></button>`).join('')+(!packs.length?'<p class="picker-empty">没有匹配的合集</p>':'')}
function countColumns(){return innerWidth<761?2:innerWidth<1051?3:innerWidth>=1600?5:4}
function renderGrid(){
 if(!data)return;
 const rank=new Map(orderedPacks().map((p,i)=>[p.id,i]));
 shown=all.filter(e=>(!onlyFollowing||following.has(e.pack.authorId))&&(!authorId||e.pack.authorId===authorId)&&(!packId||e.pack.id===packId)&&(!filterPack||e.pack.id===filterPack)&&hasKind(e,kind)&&(!query||[e.title,e.author,e.pack.title,e.pack.originalTitle,searchText?.get(e.key)].join(' ').toLowerCase().includes(query.toLowerCase()))).sort((a,b)=>rank.get(a.pack.id)-rank.get(b.pack.id)||a.entryOrder-b.entryOrder);
 const grid=$('#grid');if(!grid)return;pauseCardVideo();
 if(query&&!searchText){grid.className='empty';grid.innerHTML=searchFailed?'<p>搜索暂时不可用</p><button id=retrySearch>重试</button>':'<p role=status>正在搜索完整提示词…</p>';return}
 const more=$('#moreCases');if(more){more.hidden=shown.length<=limit;more.textContent=`继续浏览 · 还有 ${Math.max(0,shown.length-limit)} 个案例`}
 if(!shown.length){grid.className='empty';grid.innerHTML='<p>没有找到匹配的案例</p><button id="clear">清除筛选</button>';return}
 grid.className='grid';const n=countColumns(),cols=Array.from({length:n},()=>[]),heights=Array(n).fill(0);
 shown.slice(0,limit).forEach(e=>{let i=heights.indexOf(Math.min(...heights));cols[i].push(e);heights[i]+=(e.height||1000)/(e.width||800)+.24});
 grid.innerHTML=cols.map(col=>`<div class="column">${col.map(e=>`<a class="case" href="${casePath(e)}" data-case="${esc(e.key)}" aria-label="查看案例：${esc(label(e))}"><div class="picture">${image(e)}</div><div class="caption"><strong>${esc(label(e))}</strong><span class="kind">${hasKind(e,'video')?'▷ 视频':'图片'}</span></div>${showCardAuthor(e.author)?`<p class="byline">${esc(e.author)}</p>`:''}</a>`).join('')}</div>`).join('');
}
function renderCollections(){
 if(!data)return;
 const packs=orderedPacks().filter(p=>(!onlyFollowing||following.has(p.authorId))&&(!authorId||p.authorId===authorId)&&(!kind||caseCounts(p)[kind]>0)&&[p.title,p.originalTitle,p.author,p.summary].join(' ').toLowerCase().includes(collectionQuery.toLowerCase()));
 $('#collection-grid').innerHTML=packs.slice(0,collectionLimit).map(p=>`<article class="collection"><a class="collection-open" href="${packPath(p)}" data-pack="${esc(p.id)}"><div class="collection-images">${p.entries.slice(0,3).map(image).join('')}</div><div class="collection-title"><h2>${esc(p.title)}</h2><span>↗</span></div><p>${p.caseCount} 个案例 · ${packTypeLabel(p)}<span class="collection-date">上架 ${dateLabel(p)}</span></p></a>${showCardAuthor(p.author)||downloadLabel(p)?`<div class="collection-meta">${showCardAuthor(p.author)?authorLink(p):''}${downloadLabel(p)?`<span>${downloadLabel(p)}</span>`:''}</div>`:''}</article>`).join('')||'<p class="empty">没有匹配的合集</p>';
 $('#morePacks').hidden=packs.length<=collectionLimit;
}
function render(){if(!data)return;renderView();updatePageMetadata()}
function renderView(){
 document.body.className='variant-B';pauseCardVideo();
 document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===(view==='skill'?'skills':view)));
 if(renderSitePage(view))return;
 if(view==='collections'){
 app.innerHTML=`<div class="collection-head"><div><div class="eyebrow">CURATED COLLECTIONS</div><h1>把一个好方向，带回去。</h1><p>每个合集都可以直接浏览，也可以整包下载。</p></div></div><div class="collection-toolbar">${types()}${followedFilter()}<label class="search"><span>⌕</span><input aria-label="搜索全部合集" placeholder="搜索 ${data.packs.length} 个合集" value="${esc(collectionQuery)}"></label>${sortControl()}</div><div class="collections" id="collection-grid"></div><div class="load-more"><button id="morePacks">查看更多合集</button></div>`;renderCollections();return;
 }
 const grid='<div id="grid"></div><div class="load-more"><button id="moreCases">继续浏览</button></div>';
 if(packId){const p=data.packs.find(p=>p.id===packId);if(!p){app.innerHTML='<p class=empty>未找到这个合集。</p>';return}app.innerHTML=`<a class="back" href="${viewPath('collections')}" data-view="collections">← 返回全部合集</a><div class="pack-hero"><div><div class="eyebrow">COLLECTION</div><h1>${esc(p.title)}</h1><p>${p.caseCount} 个案例 · 上传者 ${authorLink(p)} · 上架 ${dateLabel(p)}</p><p class="pack-rights">${esc(p.rightsStatus==='source_unverified'?'权利归原作者 · 授权未核验':p.license)}${downloadLabel(p)?' · '+downloadLabel(p):''}</p></div><div class="pack-actions">${followButton(p)}<a class="primary" href="${esc(p.downloadUrl)}" target="_blank">下载完整合集 ↓</a></div></div><div class="filterbar revised">${types()}${search()}</div>${grid}`;renderGrid();return}
 const feature=all.find(e=>e.pack.id===data.featuredCase.pack&&e.id===data.featuredCase.entry)||all[0];
 const existingHero=app.querySelector('.cinema');
 const hero=existingHero?.querySelector('[data-case]')?.dataset.case===feature.key?existingHero:null;
 const heroMarkup=`<section class="cinema">${previewImage(feature,{hero:true})}<div class="cinema-copy"><div class="eyebrow">PROMPTDIRECTOR / CURATED</div><h1>Spot it.<br>Save it.</h1><p class="hero-tagline">刷到就存，要用就有</p></div><a class="feature-name" href="${casePath(feature)}" data-case="${esc(feature.key)}">编辑选看 · ${esc(feature.title)} ↗</a></section>`;
 const browseMarkup=`<section id="browse"><div class="compact-toolbar"><h2>精选案例</h2>${types()}${followedFilter()}${packPicker()}${search()}${sortControl()}</div>${grid}</section>`;
 if(hero){app.querySelector('#browse')?.remove();app.insertAdjacentHTML('beforeend',browseMarkup)}else app.innerHTML=heroMarkup+browseMarkup;
 renderPackOptions();renderGrid();
}
function notify(text){const host=dialog.open?dialog:document.body;if($('#toast').parentElement!==host)host.append($('#toast'));$('#toast').textContent=text;$('#toast').style.display='block';clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('#toast').style.display='none',2400)}
async function copy(text,msg){try{await navigator.clipboard.writeText(text);notify(msg)}catch{notify('复制未获浏览器允许，请手动选择文字');const prompt=$('#prompt');if(dialog.open&&prompt){const range=document.createRange();range.selectNodeContents(prompt);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)}}}
let detailRequest=0,returnFocus=null;
function mediaItems(e){return e.media?.length?e.media:[e]}
function showMedia(e,idx=0){
 const media=mediaItems(e),m=media[idx];
 $('#media-content video')?.pause();
 const video=m.mediaKind==='video'&&m.videoUrl;
 const dimensions=m.width>0&&m.height>0?`width="${Number(m.width)}" height="${Number(m.height)}" style="aspect-ratio:${Number(m.width)} / ${Number(m.height)};height:auto"`:'';
 $('#media-content').innerHTML=video?`<video ${dimensions} controls playsinline preload="metadata" poster="${esc(m.previewImageUrl||e.previewImageUrl)}" src="${esc(video)}"></video>`:`<img ${dimensions} src="${esc(m.previewImageUrl||e.previewImageUrl)}" alt="${esc(m.title||e.title)}">`;
 bindMediaError(e,idx);
 const tabs=$('.media-tabs');if(tabs)tabs.innerHTML=media.map((m,i)=>`<button data-media="${i}" class="${i===idx?'active':''}">素材 ${i+1}</button>`).join('');
 $('#prompt').textContent=(m.text??e.text)||'此案例未提供提示词。';
 const rights=m.rights||e.rights||'权利归原作者';$('#caseRights').textContent=typeof catalogEnglish!=='undefined'?catalogEnglish.labels[rights]||rights:rights;
 const author=m.author||e.author||'来源精选';$('#caseAuthor').textContent=typeof catalogEnglish!=='undefined'?catalogEnglish.labels[author]||author:author;
 const source=$('#caseSource');source.href=m.sourceUrl||e.sourceUrl||'';source.hidden=!source.getAttribute('href');
}
const mediaErrorBindings=new WeakSet();
function bindMediaError(e,idx=0){
 const element=$('#media-content video, #media-content img');if(!element||mediaErrorBindings.has(element))return;
 mediaErrorBindings.add(element);
 const onError=()=>{
  if(!element.isConnected||element.parentElement.querySelector('.media-error'))return;
  const message=document.createElement('p');message.className='media-error';message.innerHTML='<span>素材暂时无法加载</span> <button id="retryMedia">重试</button>';element.parentElement.append(message);message.querySelector('button').onclick=()=>showMedia(e,idx);
 };
 element.addEventListener('error',onError,{once:true});
 if(element.error||(element.tagName==='IMG'&&element.complete&&!element.naturalWidth))onError();
}
function caseMarkup(e,standalone=false){const heading=standalone?'h1':'h2';return `<div class="detail-media"><div id="media-content"></div>${mediaItems(e).length>1?'<div class="media-tabs"></div>':''}</div><section class="detail-info"><div class="eyebrow">${esc(e.pack.title)}</div><${heading} title="${esc(e.title)}">${esc(label(e))}</${heading}><p class="author"><span id="caseAuthor"></span> <a id="caseSource" target="_blank" rel="noopener noreferrer">查看来源 ↗</a></p><div class="prompt-head"><h3>完整提示词</h3><button id="copyPrompt" class="text-action">复制</button></div><p id="prompt" class="prompt"></p><p id="caseRights" class="rights">${esc(typeof catalogEnglish!=='undefined'?catalogEnglish.labels[e.rights]||e.rights:e.rights)}</p><div class="uploader-row"><span>上传者 ${authorLink(e.pack)}</span>${followButton(e.pack)}</div><div class="detail-actions"><a class="text-action" href="${packPath(e.pack)}" data-pack="${esc(e.pack.id)}">查看所属合集 ↗</a><button id="share">复制案例链接</button></div></section>`;}
async function openCase(key,update=true){
 const item=all.find(e=>e.key===key);if(!item)return;
 pauseCardVideo();const request=++detailRequest;selected=item;
 if(!dialog.open){returnFocus=document.activeElement;dialog.showModal()}
 const current=shown.some(x=>x.key===key)?shown:all,idx=current.findIndex(x=>x.key===key);
 $('#previous').disabled=idx<=0;$('#next').disabled=idx>=current.length-1;
 $('#detailBody').innerHTML='<p class="empty" role="status">正在读取完整案例…</p>';
 if(update){const u=new URL(location);u.searchParams.set('case',key);history.pushState(null,'',u)}
 updatePageMetadata();
 try{
  const detail=await readCase(item.pack,item.id);if(request!==detailRequest||!dialog.open)return;
  const e={...item,...detail};selected=e;
  $('#detailBody').innerHTML=caseMarkup(e);
  showMedia(e,Math.max(0,mediaItems(e).findIndex(m=>kind&&mediaType(m)===kind)));$('#detailBody').scrollTop=0;
 }catch{if(request!==detailRequest||!dialog.open)return;$('#detailBody').innerHTML='<p class="empty">案例暂时无法读取 <button id="retryCase">重试</button></p>';$('#retryCase').onclick=()=>openCase(key,false)}
}
function closeDetail(update=true){detailRequest++;dialog.querySelectorAll('video').forEach(v=>v.pause());dialog.close();selected=null;returnFocus?.focus?.();if(update){const u=new URL(location);u.searchParams.delete('case');history.replaceState(null,'',u)}updatePageMetadata()}
function goView(next){closeDetail();view=next;authorId='';onlyFollowing=false;const u=new URL(viewPath(next),location.origin);u.searchParams.delete('pack');u.searchParams.delete('author');u.searchParams.delete('skill');u.hash='';history.pushState(null,'',u);packId='';filterPack='';kind='';query='';collectionQuery='';limit=48;collectionLimit=12;render();window.scrollTo(0,0)}
function toggleFollow(id){
 following.has(id)?following.delete(id):following.add(id);
 try{localStorage.setItem(followingKey,JSON.stringify([...following]))}catch{notify('关注仅在本次页面有效')}
 document.querySelectorAll('[data-follow]').forEach(el=>{el.textContent=following.has(el.dataset.follow)?'已关注':'关注上传者';el.setAttribute('aria-pressed',following.has(el.dataset.follow))});
}
document.addEventListener('click',event=>{
 const b=event.target.closest('button,a');if(!b)return;if(b.dataset.follow){toggleFollow(b.dataset.follow);return}if(b.tagName==='A'&&(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey))return;if(!data){
  if(b.id==='copyPrompt')copy($('#prompt').textContent,'正文已复制');
  else if(b.tagName!=='A'){
   if(b.hasAttribute('data-kind'))kind=b.dataset.kind;
   if(b.hasAttribute('data-filter-pack'))filterPack=b.dataset.filterPack;
   if(b.id==='followedOnly')onlyFollowing=!onlyFollowing;
   if(b.id==='moreCases')limit+=48;
   if(b.id==='morePacks')collectionLimit+=12;
   notify(catalogLoading?'正在读取精选案例…':'互动功能暂时无法读取，请刷新重试');
  }
  return;
 }if(b.dataset.case||b.dataset.pack||b.dataset.author||b.dataset.skill)event.preventDefault();
 if(b.matches('.brand')){event.preventDefault();goView('explore')}
 if(b.dataset.view){event.preventDefault();goView(b.dataset.view)}
 if(b.hasAttribute('data-kind')){kind=b.dataset.kind;limit=48;collectionLimit=12;render()}
 if(b.hasAttribute('data-filter-pack')){filterPack=b.dataset.filterPack;limit=48;render()}
 if(b.dataset.case)openCase(b.dataset.case);
 if(b.dataset.pack){event.preventDefault();closeDetail();const u=new URL(packPath(data.packs.find(p=>p.id===b.dataset.pack)),location.origin);u.searchParams.delete('author');u.hash='';history.pushState(null,'',u);authorId='';onlyFollowing=false;packId=b.dataset.pack;view='explore';filterPack='';kind='';query='';limit=48;render();window.scrollTo(0,0)}
 if(b.hasAttribute('data-media'))showMedia(selected,Number(b.dataset.media));
 if(b.id==='clear'){onlyFollowing=false;filterPack='';kind='';query='';limit=48;render()}
 if(b.id==='moreCases'){limit+=48;renderGrid()}
 if(b.id==='morePacks'){collectionLimit+=12;renderCollections()}
 if(b.id==='close')closeDetail();
 if(b.id==='copyPrompt')copy($('#prompt').textContent,'正文已复制');
 if(b.id==='share')copy(new URL(casePath(selected),location.origin).href,'案例链接已复制');
 if(b.id==='previous'||b.id==='next'){const current=shown.some(e=>e.key===selected.key)?shown:all;const idx=current.findIndex(e=>e.key===selected.key),e=current[idx+(b.id==='next'?1:-1)];if(e)openCase(e.key)}
});
document.addEventListener('input',e=>{if(e.target.matches('[aria-label="搜索案例"]')){query=e.target.value;limit=48;if(query)loadSearch();renderGrid()}if(e.target.matches('[aria-label="搜索合集"]'))renderPackOptions(e.target.value);if(e.target.matches('[aria-label="搜索全部合集"]')){collectionQuery=e.target.value;collectionLimit=12;renderCollections()}});
document.addEventListener('change',e=>{if(e.target.id==='sort'){sort=e.target.value;limit=48;collectionLimit=12;render()}});
dialog.addEventListener('cancel',e=>{e.preventDefault();closeDetail()});dialog.addEventListener('click',e=>{if(e.target===dialog)closeDetail()});
document.addEventListener('click',e=>{const picker=$('.pack-picker');if(picker&&!picker.contains(e.target))picker.open=false});
document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,[contenteditable]'))return;if(dialog.open&&['ArrowLeft','ArrowRight'].includes(e.key)){const b=$(e.key==='ArrowRight'?'#next':'#previous');if(!b.disabled)b.click()}});
let resize;addEventListener('resize',()=>{clearTimeout(resize);resize=setTimeout(renderGrid,150)});
let searchText=null,searchFailed=false,searchPromise=null,cardVideo=null;
function pauseCardVideo(){if(cardVideo){cardVideo.pause();cardVideo.removeAttribute('src');cardVideo.load();cardVideo.remove();cardVideo=null}}
async function loadSearch(){
 if(searchText||searchPromise)return;searchFailed=false;
 searchPromise=readWebsiteJson('website/search.json').then(rows=>{searchText=new Map(rows)}).catch(()=>{searchFailed=true}).finally(()=>{searchPromise=null;if(query)renderGrid()});
}
document.addEventListener('click',e=>{if(e.target.id==='retrySearch'){loadSearch();renderGrid()}if(e.target.id==='retryCatalog')startWebsite()});
document.addEventListener('pointerover',event=>{
 const card=event.target.closest('.case');if(!card||card.contains(event.relatedTarget)||!matchMedia('(hover:hover)').matches||matchMedia('(prefers-reduced-motion:reduce)').matches)return;
 const entry=all.find(e=>e.key===card.dataset.case);if(!entry?.videoUrl)return;
 pauseCardVideo();const player=document.createElement('video');player.className='hover-video';player.muted=true;player.playsInline=true;player.loop=true;player.src=entry.videoUrl;card.querySelector('.picture').append(player);cardVideo=player;player.play().catch(()=>{if(cardVideo===player)pauseCardVideo()});
});
document.addEventListener('pointerout',e=>{const card=e.target.closest('.case');if(card&&!card.contains(e.relatedTarget))pauseCardVideo()});
addEventListener('scroll',pauseCardVideo,{passive:true});document.addEventListener('visibilitychange',()=>{if(document.hidden)pauseCardVideo()});
function restoreRoute(){
 closeDetail(false);const u=new URL(location);const route=pageRoute();view=route.view;authorId=route.author||'';packId=route.pack||'';render();const key=view==='case'?null:route.case;if(key){if(all.some(e=>e.key===key))openCase(key,false);else notify('未找到这个案例。')}
}
addEventListener('popstate',restoreRoute);
async function startWebsite(){
 catalogLoading=true;
 if(!app.dataset.prerendered)app.innerHTML='<p class="loading" role="status">正在读取精选案例…</p>';
 try{
  [data,siteData]=await readWebsite();localizeCatalogs(data,siteData);all=[];
  data.packs.forEach(p=>p.entries.forEach((e,i)=>{e.pack=p;e.entryOrder=i;all.push(e)}));
  restoreRoute();
 }catch{if(!app.dataset.prerendered)app.innerHTML='<p class="empty">精选案例暂时无法读取。<button id="retryCatalog">重试</button></p>';else notify('互动功能暂时无法读取，请刷新重试')}finally{catalogLoading=false}
}
