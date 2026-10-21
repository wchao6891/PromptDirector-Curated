// Supplemental public pages share the main website state and reviewed catalogs.
let renderPending=null,casePageRequest=0;
function renderSitePage(next){
 if(next==='case'){renderPending=renderCasePage(pageRoute().case);return true;}
 if(next==='about'){
  app.innerHTML=`<section class="about-page"><div class="eyebrow">ABOUT PROMPTDIRECTOR</div><h1>关于 PromptDirector</h1><div class="about-story"><p>最初做 PromptDirector，只是因为一个念头：我想做一条 AI 视频。</p><p>但真正动手时，才发现手头没有一套好用的创作资产。参考案例、视觉设定，还有能让模型稳定理解的提示词方法，都需要一点点积累。</p><p>于是我想，索性做一个采集插件吧。看到好的案例，就一键保存下来。没想到随着开发逐渐深入，功能也一点点丰富，最终成了你现在看到的样子。</p><p>这个插件里，有我认真投入的时间和心力。希望你会喜欢，也希望它能帮你把一个创作念头，慢慢变成作品。</p><p><strong>PromptDirector 插件会永久免费，并持续开源更新。</strong></p></div><section class="contact-panel"><h2>联系我</h2><div class="about-contacts"><div class="contact-line"><span>邮箱</span><a href="mailto:${esc(siteData.contact.email)}">${esc(siteData.contact.email)}</a><button data-copy-contact="email" aria-label="复制邮箱">复制</button></div><div class="contact-line"><span>微信</span><strong>${esc(siteData.contact.wechat)}</strong><button data-copy-contact="wechat" aria-label="复制微信号">复制</button></div></div></section></section>`;return true;
 }
 if(next==='submit'){
  app.innerHTML=`<section class="submission-page"><div class="eyebrow">SHARE YOUR WORK</div><h1>好作品，值得被更多人看见。</h1><p class="lead">分享案例，或把你的创作方法整理成 Skill。投稿通过人工审核后进入精选。</p><div class="submission-options"><article><span>01 / CASES</span><h2>分享案例合集</h2><p>在插件中选好案例并生成精选投稿包，保留完整提示词、原作者和来源。支持一个 ZIP 或全部分卷。</p><a class="primary" href="https://github.com/wchao6891/PromptDirector-Curated/issues/new?template=curated-submission.yml" target="_blank" rel="noopener">提交案例投稿 ↗</a><small>在 GitHub 提交，需要登录。</small></article><article><span>02 / SKILLS</span><h2>分享创作 Skill</h2><p>在插件中生成 Skill 投稿 ZIP，包含方法文档与成果封面。按 CC BY 4.0 提交公开审核。</p><a class="primary" href="https://github.com/wchao6891/PromptDirector-Curated/issues/new?template=curated-skill-submission.yml" target="_blank" rel="noopener">提交 Skill 投稿 ↗</a><small>在 GitHub 提交，需要登录。</small></article></div><div class="submission-note"><h2>发布前，由你决定公开什么</h2><p>确认署名、内容权利和公开范围；不要包含私人资料、密钥或无权公开的素材。第三方作品可以推荐收录，但不能替原作者授予许可。提交后由维护者审核，投稿不会自动公开上架。</p><a class="text-action" href="guide.html">查看使用指南</a> · <a class="text-action" href="support.html#rights">权利反馈与下架申请</a></div></section>`;return true;
 }
 if(next==='skills'){
  app.innerHTML=`<section class="collection-head"><div><div class="eyebrow">CREATIVE METHODS</div><h1>把好方法，变成下一次创作。</h1><p>浏览创作方法，查看说明，按需下载。</p></div><a class="text-action" href="submit/">分享 Skill ↗</a></section><div class="compact-toolbar"><h2>精选 Skill</h2>${followedFilter()}<label class="search"><span>⌕</span><input aria-label="搜索 Skill" placeholder="搜索名称、作者、用途" value="${esc(skillQuery)}"></label><label class="sort-control"><select aria-label="Skill 排序" id="skillSort"><option value="newest" ${skillSort==='newest'?'selected':''}>最新优先</option><option value="recommended" ${skillSort==='recommended'?'selected':''}>编辑推荐</option></select></label></div><div id="skillGrid" class="skill-grid"></div>`;renderSkills();return true;
 }
 if(next==='skill'){
  const id=pageRoute().skill,s=siteData.skills.find(x=>x.id===id);if(!s){app.innerHTML='<p class="empty">未找到这个 Skill。<a href="skills/">返回精选 Skill</a></p>';return true}
  app.innerHTML=`<a class="back" href="${viewPath('skills')}" data-view="skills">← 返回精选 Skill</a><article class="skill-detail-page">${skillCover(s)}<section><div class="eyebrow">CREATIVE SKILL</div><h1>${esc(s.title)}</h1><p class="lead">${esc(s.summary)}</p><div class="uploader-row"><span>发布者 ${authorLink(s)}</span>${followButton(s)}</div><details class="skill-maintenance"><summary>版本与许可</summary><p>版本 ${esc(s.version)} · ${esc(s.license)} · 人工审核通过</p><p>调用名：${esc(s.callName)}</p><p>文档与调用名保留原始语言。</p></details><div class="detail-actions"><a class="primary" href="${esc(s.downloadUrl)}">下载 Skill ↓</a><button id="copyPage">复制链接</button></div></section></article>`;return true;
 }
 if(next==='author'){
  const p=data.packs.find(p=>p.authorId===authorId)||siteData.skills.find(s=>s.authorId===authorId);
  if(!p){app.innerHTML='<p class="empty">未找到这个上传者。<a href="collections/">返回合集</a></p>';return true}
  app.innerHTML=`<div class="collection-head author-head"><div><div class="eyebrow">CONTRIBUTOR</div><h1>${esc(p.author)}</h1><p>已发布的精选合集与创作 Skill</p></div>${followButton(p)}</div><div class="compact-toolbar"><h2>精选合集</h2>${types()}${sortControl()}</div><div class="collections" id="collection-grid"></div><div class="load-more"><button id="morePacks">查看更多合集</button></div><div class="compact-toolbar"><h2>创作 Skill</h2></div><div id="skillGrid" class="skill-grid"></div>`;renderCollections();renderSkills();return true;
 }
 return false;
}
function skillCover(s){return s.cover?previewImage({previewImageUrl:s.cover.path,thumbnails:s.cover.thumbnails,width:s.cover.width,height:s.cover.height,title:s.title},{className:"skill-cover"}):''}
function renderSkills(){
 if(!data)return;
 const items=siteData.skills.filter(s=>(!onlyFollowing||following.has(s.authorId))&&(!authorId||s.authorId===authorId)&&[s.title,s.originalTitle,s.callName,s.summary,s.author].join(' ').toLowerCase().includes(skillQuery.toLowerCase())).sort((a,b)=>skillSort==='recommended'?a.order-b.order:Date.parse(b.reviewedAt)-Date.parse(a.reviewedAt)||a.order-b.order);
 $('#skillGrid').innerHTML=items.map(s=>`<article class="skill-card"><a class="skill-open" href="${skillPath(s)}" data-skill="${esc(s.id)}">${skillCover(s)}<h2>${esc(s.title)}</h2><p>${esc(s.summary)}</p></a><div class="skill-actions">${authorLink(s)}<a href="${esc(s.downloadUrl)}">下载 ↓</a></div></article>`).join('')||'<p class="empty">暂无匹配的 Skill</p>';
}
function openSkill(id){closeDetail();const u=new URL(skillPath(siteData.skills.find(s=>s.id===id)),location.origin);u.searchParams.delete('author');u.searchParams.delete('pack');u.hash='';history.pushState(null,'',u);authorId='';view='skill';render();window.scrollTo(0,0)}
document.addEventListener('click',e=>{
 const b=e.target.closest('button,a');if(!b)return;if(b.tagName==='A'&&(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey))return;if(data&&(b.dataset.skill||b.dataset.author))e.preventDefault();
 if(!data)return;
 if(b.id==='followedOnly'){onlyFollowing=!onlyFollowing;limit=48;collectionLimit=12;render()}
 if(b.dataset.author){e.preventDefault();closeDetail();authorId=b.dataset.author;view='author';onlyFollowing=false;kind='';collectionQuery='';skillQuery='';const u=new URL(authorPath({authorId}),location.origin);u.searchParams.delete('pack');u.searchParams.delete('skill');u.hash='';history.pushState(null,'',u);render();window.scrollTo(0,0)}
 if(b.dataset.skill)openSkill(b.dataset.skill);
 if(b.dataset.copyContact)copy(siteData.contact[b.dataset.copyContact],'联系方式已复制');
 if(b.id==='copyPage')copy(location.href,'链接已复制');
});
document.addEventListener('input',e=>{if(e.target.matches('[aria-label="搜索 Skill"]')){skillQuery=e.target.value;renderSkills()}});
document.addEventListener('change',e=>{if(e.target.id==='skillSort'){skillSort=e.target.value;renderSkills()}});

async function renderCasePage(key){
 const item=all.find(e=>e.key===key),request=++casePageRequest;
 if(!item){app.innerHTML='<p class="empty">未找到这个案例。</p>';return}
 if(!app.querySelector('.standalone-case'))app.innerHTML='<p class="loading">正在读取完整案例…</p>';
 try{
  const detail=await readCase(item.pack,item.id);if(request!==casePageRequest||view!=='case')return;
  const entry={...item,...detail};selected=entry;
  if(app.querySelector('.standalone-case')?.dataset.casePage===key){bindMediaError(entry,Number(app.querySelector('.media-tabs .active')?.dataset.media||0));return}
  app.innerHTML=`<article class="standalone-case" data-case-page="${esc(key)}"><a class="back" href="${packPath(item.pack)}" data-pack="${esc(item.pack.id)}">← 返回所属合集</a><div class="standalone-detail">${caseMarkup(entry,true)}</div></article>`;
  showMedia(entry);
 }catch{if(view!=='case')return;app.innerHTML='<p class="empty">案例暂时无法读取 <button id="retryStandalone">重试</button></p>';document.querySelector('#retryStandalone').onclick=()=>renderCasePage(key)}
}

startWebsite();
