import {parse,type DefaultTreeAdapterTypes} from 'parse5';
import type {Budget} from './tmdb';
const PUBLICATIONS=['www.criterion.com','www.sensesofcinema.com','www.filmcomment.com','www.bfi.org.uk','link.springer.com','link.springernature.com','www.festival-cannes.com','iffr.com','www.rogerebert.com','mubi.com','www.reverse-shot.com','reverseshot.org','www.e-flux.com','www.sabzian.be','www.locarnofestival.ch','www.berlinale.de','miff.com.au','widescreenjournal.org','www.davidbordwell.net','jonathanrosenbaum.net','www.screeningthepast.com','www.cineaste.com','www.lolajournal.com','offscreen.com','journals.sagepub.com','academic.oup.com','muse.jhu.edu','www.tandfonline.com','cinemascopemag.com','www.biff.kr','eng.koreafilm.or.kr','www.koreafilm.or.kr','www.kmdb.or.kr','journal.kci.go.kr','www.koreanfilm.org','www.siff.net','www.filmlinc.org'];
export const SOURCE_HOSTS=[...new Set(PUBLICATIONS.flatMap(host=>host.startsWith('www.')?[host,host.slice(4)]:[host]))];
export function allowedSourceUrl(raw:string):boolean{try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!SOURCE_HOSTS.includes(u.hostname))return false;if((u.hostname==='www.criterion.com'||u.hostname==='criterion.com')&&!u.pathname.startsWith('/current/posts/'))return false;return true}catch{return false}}
export function normalizedText(text:string){return text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
export function supports(text:string,span:string,titles:string[]){const haystack=normalizedText(text);return span.trim().length>=20&&haystack.includes(normalizedText(span))&&titles.length>0&&titles.every(t=>normalizedText(t).length>2&&normalizedText(span).includes(normalizedText(t)));}
export type SourceDocument={url:string,title:string,author:string|null,date:string|null,text:string};
const OMITTED_TAGS=new Set(['script','style','nav','footer','aside','svg','form','noscript','template','head']);
const BLOCK_TAGS=new Set(['article','main','p','div','h1','h2','h3','h4','h5','h6','li','section','blockquote','br','hr','td','th','tr','ul','ol']);
type HtmlNode=DefaultTreeAdapterTypes.Node;
function nodeText(root:HtmlNode){
 const parts:string[]=[],pending:(HtmlNode|string)[]=[root];
 while(pending.length){const node=pending.pop()!;
  if(typeof node==='string'){parts.push(node);continue;}
  if(node.nodeName==='#text'&&'value' in node){parts.push(node.value);continue;}
  if('tagName' in node){if(OMITTED_TAGS.has(node.tagName))continue;if(BLOCK_TAGS.has(node.tagName)){parts.push(' ');pending.push(' ');}}
  if('childNodes' in node)for(let i=node.childNodes.length-1;i>=0;i--)pending.push(node.childNodes[i]);
 }
 return parts.join('').replace(/\s+/g,' ').trim();
}
// Parse article text and entities without browser or Cloudflare globals.
export function extractSourceHtml(html:string){
 const document=parse(html),pending:HtmlNode[]=[document],metadata:Record<string,string>[]=[];
 let article:HtmlNode|undefined,main:HtmlNode|undefined,body:HtmlNode|undefined,title:HtmlNode|undefined;
 while(pending.length){const node=pending.pop()!;
  if('tagName' in node){
   if(node.tagName==='meta')metadata.push(Object.fromEntries(node.attrs.map(a=>[a.name,a.value])));
   if(node.tagName==='title')title??=node;
   if(node.tagName==='body')body??=node;
   if(node.tagName==='article')article??=node;
   if(node.tagName==='main')main??=node;
   if(OMITTED_TAGS.has(node.tagName)&&node.tagName!=='head')continue;
  }
  if('childNodes' in node)for(let i=node.childNodes.length-1;i>=0;i--)pending.push(node.childNodes[i]);
 }
 const meta=(names:string[])=>metadata.find(a=>names.includes(a.name?.toLowerCase())||names.includes(a.property?.toLowerCase()))?.content?.trim()??'';
 return {title:meta(['og:title','citation_title'])||(title?nodeText(title):''),author:meta(['author','citation_author'])||null,date:meta(['article:published_time','citation_publication_date','date'])||null,text:nodeText(article??main??body??document).slice(0,80000)};
}
const sourceCache=new Map<string,{at:number,document:SourceDocument}>();
export async function readSource(url:string,budget:Budget,signal:AbortSignal):Promise<string|null>{return (await readSourceDocument(url,budget,signal))?.text??null;}
export async function readSourceDocument(url:string,budget:Budget,signal:AbortSignal):Promise<SourceDocument|null>{
 const hit=sourceCache.get(url);if(hit&&Date.now()-hit.at<86_400_000)return hit.document;
 try{let current=url;for(let redirect=0;redirect<4;redirect++){
  if(!allowedSourceUrl(current)||budget.remaining--<=0)return null;
  const res=await fetch(current,{redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(9000)]),headers:{Accept:'text/html','User-Agent':'STRADA/2.0 (film criticism reader)'}});
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

export function retrievedSources(data:any){const found=new Map<string,string>();for(const item of data.output??[]){if(item.type==='web_search_call')for(const s of item.action?.sources??[]){const url=canonicalSourceUrl(s.url??'');if(url&&allowedSourceUrl(url))found.set(url,s.title??'');}if(item.type==='message')for(const p of item.content??[])for(const a of p.annotations??[]){const url=canonicalSourceUrl(a.url??'');if(url&&allowedSourceUrl(url))found.set(url,a.title??'');}}return [...found].map(([url,title])=>({url,title}));}
