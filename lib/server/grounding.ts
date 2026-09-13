import {parse,type DefaultTreeAdapterTypes} from 'parse5';
import dns from 'node:dns';
import https from 'node:https';
import {isIP} from 'node:net';
import type {Budget} from './tmdb';
const PUBLICATIONS=['www.criterion.com','www.sensesofcinema.com','www.filmcomment.com','www.bfi.org.uk','link.springer.com','link.springernature.com','www.festival-cannes.com','iffr.com','www.rogerebert.com','mubi.com','www.reverse-shot.com','reverseshot.org','www.e-flux.com','www.sabzian.be','www.locarnofestival.ch','www.berlinale.de','miff.com.au','widescreenjournal.org','www.davidbordwell.net','jonathanrosenbaum.net','www.screeningthepast.com','www.cineaste.com','www.lolajournal.com','offscreen.com','journals.sagepub.com','academic.oup.com','muse.jhu.edu','www.tandfonline.com','cinemascopemag.com','www.biff.kr','eng.koreafilm.or.kr','www.koreafilm.or.kr','www.kmdb.or.kr','journal.kci.go.kr','www.koreanfilm.org','www.siff.net','www.filmlinc.org'];
export const SOURCE_HOSTS=[...new Set(PUBLICATIONS.flatMap(host=>host.startsWith('www.')?[host,host.slice(4)]:[host]))];
export function allowedSourceUrl(raw:string):boolean{try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!SOURCE_HOSTS.includes(u.hostname))return false;if((u.hostname==='www.criterion.com'||u.hostname==='criterion.com')&&!u.pathname.startsWith('/current/posts/'))return false;return true}catch{return false}}
// Broader critical publications must still be public HTTPS article URLs. Host eligibility
// is not evidence quality: the fetched article must separately pass relevance checks.
export function allowedPublicSourceUrl(raw:string):boolean{try{
 const u=new URL(raw),host=u.hostname.toLowerCase();
 if(u.protocol!=='https:'||u.username||u.password||u.port||isIP(host.replace(/^\[|\]$/g,''))||!host.includes('.')||/\.(?:localhost|local|internal|test|invalid|example)$/.test(host))return false;
 if(/(?:^|\.)(?:localhost|metadata\.google\.internal|amazonaws\.com|nip\.io|sslip\.io)$/.test(host))return false;
 if(SOURCE_HOSTS.includes(host))return allowedSourceUrl(raw);
 if(/(?:^|\.)(?:imdb\.com|themoviedb\.org|letterboxd\.com|rottentomatoes\.com|wikipedia\.org|wikidata\.org|reddit\.com|facebook\.com|instagram\.com|youtube\.com|tiktok\.com|pinterest\.com|amazon\.com)$/.test(host))return false;
 return u.pathname!=='/'&&!/\/(?:search|tag|tags|category|shop|store|login|signin|best-movies|top-\d+)(?:\/|$)/i.test(u.pathname)&&!/[.](?:jpg|png|gif|webp|zip|exe|mp4)$/i.test(u.pathname);
 }catch{return false;}}
export function isPublicSourceAddress(address:string){
 if(isIP(address)===4){const [a,b,c]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));}
 // Accept ordinary globally routed IPv6 only; reject local, mapped, transition and documentation ranges.
 if(isIP(address)===6)return /^[23][0-9a-f]{0,3}:/i.test(address)&&!/^2001:(?:0{1,4}:|0?db8:|0{0,2}10:|0{0,2}20:)|^2002:/i.test(address);
 return false;
}
async function publicSourceResponse(url:string,signal:AbortSignal):Promise<Response>{
 return new Promise((resolve,reject)=>{
  const request=https.request(url,{method:'GET',agent:false,signal,headers:{Accept:'text/html','Accept-Encoding':'identity','User-Agent':'STRADA/3.0 (film criticism reader)'},lookup:(hostname,options,callback)=>{
   dns.lookup(hostname,{all:true,verbatim:true},(error,addresses)=>{
    if(error){callback(error,'',4);return;}
    if(!addresses.length||addresses.some(item=>!isPublicSourceAddress(item.address))){callback(new Error('The article host is not public.'),'',4);return;}
    // The address checked here is the address used by this socket, preventing a second DNS lookup.
    if(options.all)(callback as (...args:unknown[])=>void)(null,addresses);else callback(null,addresses[0].address,addresses[0].family);
   });
  }},response=>{
   const headers=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
   const status=response.statusCode??502;
   if(status>=300&&status<400){resolve(new Response(null,{status,headers}));response.destroy();return;}
   if(status!==200||!String(response.headers['content-type']??'').includes('text/html')){resolve(new Response(null,{status,headers}));response.destroy();return;}
   let bytes=0;const chunks:Buffer[]=[];
   response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2_000_000){request.destroy(new Error('Article exceeds the read limit.'));return;}chunks.push(chunk);});
   response.on('error',reject);response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status,headers})));
  });request.on('error',reject);request.end();
 });
}
export function normalizedText(text:string){return text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
export function supports(text:string,span:string,titles:string[]){const haystack=normalizedText(text);return span.trim().length>=20&&haystack.includes(normalizedText(span))&&titles.length>0&&titles.every(t=>normalizedText(t).length>2&&normalizedText(span).includes(normalizedText(t)));}
export type SourceDocument={url:string,title:string,author:string|null,date:string|null,text:string,paragraphs?:string[],article?:boolean,academic?:boolean};
const OMITTED_TAGS=new Set(['script','style','nav','footer','aside','svg','form','noscript','template','head']);
const BLOCK_TAGS=new Set(['article','main','p','div','h1','h2','h3','h4','h5','h6','li','section','blockquote','br','hr','td','th','tr','ul','ol']);
type HtmlNode=DefaultTreeAdapterTypes.Node;
function nodeText(root:HtmlNode,paragraphs=false){
 const parts:string[]=[],pending:(HtmlNode|string)[]=[root];
 while(pending.length){const node=pending.pop()!;
  if(typeof node==='string'){parts.push(node);continue;}
  if(node.nodeName==='#text'&&'value' in node){parts.push(node.value);continue;}
  if('tagName' in node){if(OMITTED_TAGS.has(node.tagName))continue;if(BLOCK_TAGS.has(node.tagName)){parts.push(paragraphs?'\n\n':' ');pending.push(paragraphs?'\n\n':' ');}}
  if('childNodes' in node)for(let i=node.childNodes.length-1;i>=0;i--)pending.push(node.childNodes[i]);
 }
 return paragraphs?parts.join('').split(/\n+/).map(p=>p.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n\n'):parts.join('').replace(/\s+/g,' ').trim();
}
// Parse article text and entities without browser or Cloudflare globals.
export function extractSourceHtml(html:string){
 const document=parse(html),pending:HtmlNode[]=[document],metadata:Record<string,string>[]=[];
 let article:HtmlNode|undefined,main:HtmlNode|undefined,body:HtmlNode|undefined,title:HtmlNode|undefined,byline:HtmlNode|undefined;
 while(pending.length){const node=pending.pop()!;
  if('tagName' in node){
   if(node.tagName==='meta')metadata.push(Object.fromEntries(node.attrs.map(a=>[a.name,a.value])));
   if(node.tagName==='title')title??=node;
   if(node.tagName==='body')body??=node;
   if(node.tagName==='article')article??=node;
   if(node.tagName==='main')main??=node;
   if(!byline&&node.attrs.some(a=>(a.name==='rel'&&a.value.split(/\s+/).includes('author'))||(a.name==='class'&&/(?:^|\s)(?:byline|author-name|entry-author|p-author)(?:\s|$)/.test(a.value))))byline=node;
   if(OMITTED_TAGS.has(node.tagName)&&node.tagName!=='head')continue;
  }
  if('childNodes' in node)for(let i=node.childNodes.length-1;i>=0;i--)pending.push(node.childNodes[i]);
 }
 const meta=(names:string[])=>metadata.find(a=>names.includes(a.name?.toLowerCase())||names.includes(a.property?.toLowerCase()))?.content?.trim()??'';
 const content=article??main??body??document;
 const author=meta(['author','citation_author'])||(byline?nodeText(byline).replace(/^by\s+/i,'').slice(0,180):'');
 return {title:meta(['og:title','citation_title'])||(title?nodeText(title):''),author:author||null,date:meta(['article:published_time','citation_publication_date','date'])||null,text:nodeText(content).slice(0,80000),paragraphs:nodeText(content,true).slice(0,80000).split(/\n\n+/),article:!!article||meta(['og:type'])==='article',academic:!!meta(['citation_journal_title','citation_doi'])};
}
const sourceCache=new Map<string,{at:number,document:SourceDocument}>();
export async function readSource(url:string,budget:Budget,signal:AbortSignal):Promise<string|null>{return (await readSourceDocument(url,budget,signal))?.text??null;}
export async function readSourceDocument(url:string,budget:Budget,signal:AbortSignal,options:{allowPublicWeb?:boolean}={}):Promise<SourceDocument|null>{
 const allowed=options.allowPublicWeb?allowedPublicSourceUrl:allowedSourceUrl;
 if(!allowed(url)||signal.aborted)return null;
 const hit=sourceCache.get(url);if(hit&&allowed(hit.document.url)&&Date.now()-hit.at<86_400_000)return hit.document;
 try{let current=url;for(let redirect=0;redirect<4;redirect++){
  if(!allowed(current)||signal.aborted||budget.remaining--<=0)return null;
  const readSignal=AbortSignal.any([signal,AbortSignal.timeout(options.allowPublicWeb?6500:9000)]);
  const res=allowedSourceUrl(current)?await fetch(current,{redirect:'manual',signal:readSignal,headers:{Accept:'text/html','User-Agent':'STRADA/3.0 (film criticism reader)'}}):await publicSourceResponse(current,readSignal);
  if(res.status>=300&&res.status<400){const loc=res.headers.get('location');await res.body?.cancel();if(!loc)return null;current=new URL(loc,current).href;continue;}
  if(!res.ok||!(res.headers.get('content-type')??'').includes('text/html')){await res.body?.cancel();return null;}
  const reader=res.body?.getReader();if(!reader)return null;let bytes=0,html='';const decoder=new TextDecoder();
  while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>2_000_000){await reader.cancel();return null;}html+=decoder.decode(chunk.value,{stream:true});}
  html+=decoder.decode();
  const extracted=extractSourceHtml(html);if(extracted.text.length<450)return null;
  const document={url:current,...extracted,title:extracted.title||new URL(current).hostname};
  if(sourceCache.size>=120)sourceCache.delete(sourceCache.keys().next().value!);sourceCache.set(url,{at:Date.now(),document});return document;
 }return null;}catch{return null;}
}
export function filmMentioned(text:string,film:{title:string,titleKo?:string,originalTitle?:string,aliases?:string[]}){return [film.title,film.titleKo,film.originalTitle,...film.aliases??[]].some(title=>!!title&&(/[\p{Script=Hangul}\p{Script=Han}]/u.test(title)&&title.length>=2?text.normalize('NFKC').includes(title.normalize('NFKC')):titleMentioned(text,title)));}
export function canonicalSourceUrl(raw:string){try{const u=new URL(raw);if(u.protocol==='http:')u.protocol='https:';u.hash='';for(const key of [...u.searchParams.keys()])if(key.startsWith('utm_')||['srsltid','fbclid','gclid'].includes(key))u.searchParams.delete(key);return u.href;}catch{return '';}}

// English articles and typographic punctuation vary across catalogues and criticism.
const titleKey=(title:string)=>normalizedText(title.replace(/^(?:the|an|a)\s+/i,''));
export function titleMatches(a:string,b:string){return titleKey(a)===titleKey(b);}
export function titleMentioned(text:string,title:string){
 const plain=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi,(_,hex,decimal)=>String.fromCodePoint(parseInt(hex||decimal,hex?16:10))).replace(/&(?:amp|quot|apos|nbsp|ndash|mdash);/g,' ');
 const words=plain(title).match(/[\p{L}\p{N}]+/gu)??[];if(!words.length)return false;
 if(words.length>2&&/^(the|an|a)$/i.test(words[0]!))words.shift();
 const pattern=words.join('[^\\p{L}\\p{N}]+');
 return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`,words.join('').length<=2?'u':'iu').test(plain(text));
}

export function retrievedSources(data:any,options:{allowPublicWeb?:boolean}={}){const allowed=options.allowPublicWeb?allowedPublicSourceUrl:allowedSourceUrl,found=new Map<string,string>();for(const item of Array.isArray(data?.output)?data.output:[]){if(item?.type==='web_search_call')for(const s of Array.isArray(item.action?.sources)?item.action.sources:[]){const url=canonicalSourceUrl(s.url??'');if(url&&allowed(url))found.set(url,s.title??'');}if(item?.type==='message')for(const p of Array.isArray(item.content)?item.content:[])for(const a of Array.isArray(p.annotations)?p.annotations:[]){const url=canonicalSourceUrl(a.url??'');if(url&&allowed(url))found.set(url,a.title??'');}}return [...found].map(([url,title])=>({url,title}));}
