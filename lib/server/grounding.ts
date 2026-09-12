import type {Budget} from './tmdb';
const PUBLICATIONS=['www.criterion.com','www.sensesofcinema.com','www.filmcomment.com','www.bfi.org.uk','link.springer.com','link.springernature.com','www.festival-cannes.com','iffr.com','www.rogerebert.com','mubi.com','www.reverse-shot.com','reverseshot.org','www.e-flux.com','www.sabzian.be','www.locarnofestival.ch','www.berlinale.de','miff.com.au','widescreenjournal.org'];
export const SOURCE_HOSTS=[...new Set(PUBLICATIONS.flatMap(host=>host.startsWith('www.')?[host,host.slice(4)]:[host]))];
export function allowedSourceUrl(raw:string):boolean{try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!SOURCE_HOSTS.includes(u.hostname))return false;if((u.hostname==='www.criterion.com'||u.hostname==='criterion.com')&&!u.pathname.startsWith('/current/posts/'))return false;return true}catch{return false}}
export function normalizedText(text:string){return text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
export function supports(text:string,span:string,titles:string[]){const haystack=normalizedText(text);return span.trim().length>=20&&haystack.includes(normalizedText(span))&&titles.length>0&&titles.every(t=>normalizedText(t).length>2&&normalizedText(span).includes(normalizedText(t)));}
export async function readSource(url:string,budget:Budget,signal:AbortSignal):Promise<string|null>{
 try{let current=url;for(let redirect=0;redirect<3;redirect++){
  if(!allowedSourceUrl(current)||budget.remaining--<=0)return null;
  const res=await fetch(current,{redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(7000)]),headers:{Accept:'text/html','User-Agent':'STRADA/1.1 (film research)'}});
  if(res.status>=300&&res.status<400){const loc=res.headers.get('location');await res.body?.cancel();if(!loc)return null;current=new URL(loc,current).href;continue;}
  if(!res.ok||!(res.headers.get('content-type')??'').includes('text/html')){await res.body?.cancel();return null;}
  const reader=res.body?.getReader();if(!reader)return null;let bytes=0;let html='';const decoder=new TextDecoder();
  while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>400_000){await reader.cancel();return null;}html+=decoder.decode(chunk.value,{stream:true});}
  const clean=html.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
  let text='';const transformed=new HTMLRewriter().on('*',{text(chunk){text+=chunk.text+' ';}}).transform(new Response(clean));await transformed.arrayBuffer();
  return text.replace(/\s+/g,' ').trim();
 }return null;}catch{return null;}
}

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
