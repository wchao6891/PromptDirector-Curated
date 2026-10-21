// New clean routes share one locale prefix; legacy query links keep working.
(()=>{
 const root=new URL('.',document.currentScript.src),key='pd-lang';
 const english=value=>!/^zh(?:-|$)/i.test(value||'');
 function counterpart(language){const url=new URL(location.href),relative=url.pathname.slice(root.pathname.length).replace(/^en\//,'');url.pathname=root.pathname+(language==='en'?'en/':'')+relative;url.searchParams.set('lang',language);return url.href}
 document.addEventListener('click',event=>{const link=event.target.closest('[data-pd-set-lang]');if(!link)return;const language=link.dataset.pdSetLang;link.href=counterpart(language);try{localStorage.setItem(key,language)}catch{}},true);
 for(const type of ['pointerdown','focusin','contextmenu'])document.addEventListener(type,event=>{const link=event.target.closest('[data-pd-set-lang]');if(link)link.href=counterpart(link.dataset.pdSetLang)},true);
 const requested=new URL(location.href).searchParams.get('lang');let chosen=requested;try{if(requested)localStorage.setItem(key,requested);else chosen=localStorage.getItem(key)}catch{}
 if(document.documentElement.lang==='en')return;
 if(!chosen&&/bot|crawl|spider|slurp|bingpreview/i.test(navigator.userAgent||''))return;
 if(english(chosen||navigator.languages?.[0]||navigator.language||'en'))location.replace(counterpart('en'));
})();
