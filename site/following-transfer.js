const key='promptdirector.curated.following.v1';
const english=document.documentElement.lang==='en';
const words=english?{saved:'Following list exported.',merged:'Following list imported. Existing follows were preserved.',invalid:'Could not import this file. Choose a PromptDirector following list.',failed:'Browser storage is unavailable. Nothing was changed.'}:{saved:'关注清单已导出。',merged:'关注清单已导入，原有关注已保留。',invalid:'无法导入，请选择 PromptDirector 关注清单文件。',failed:'浏览器存储不可用，未修改关注清单。'};
const status=document.querySelector('#transfer-status');
function existing(){const rows=JSON.parse(localStorage.getItem(key)||'[]');if(!Array.isArray(rows))throw Error('storage');return rows.filter(v=>typeof v==='string')}
document.querySelector('#export-following').onclick=()=>{
 try{const data={format:'promptdirector-following',version:1,authors:existing(),language:localStorage.getItem('pd-lang')};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='promptdirector-following.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status.textContent=words.saved}catch{status.textContent=words.failed}
};
document.querySelector('#import-following').onchange=async event=>{
 const file=event.target.files[0];if(!file)return;
 try{const value=JSON.parse(await file.text());if(value.format!=='promptdirector-following'||value.version!==1||!Array.isArray(value.authors)||value.authors.some(v=>typeof v!=='string'||!v.trim()))throw Error('format');const authors=[...new Set([...existing(),...value.authors])];localStorage.setItem(key,JSON.stringify(authors));if(['en','zh-CN'].includes(value.language))localStorage.setItem('pd-lang',value.language);status.textContent=words.merged}catch{status.textContent=words.invalid}finally{event.target.value=''}
};
