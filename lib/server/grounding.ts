import type {Budget} from './tmdb';
export const SOURCE_HOSTS=['www.criterion.com','www.sensesofcinema.com','www.filmcomment.com','www.bfi.org.uk','link.springer.com','link.springernature.com','www.festival-cannes.com','iffr.com','www.rogerebert.com','mubi.com','www.reverse-shot.com','reverseshot.org','www.e-flux.com','www.sabzian.be','www.locarnofestival.ch','www.berlinale.de','miff.com.au','widescreenjournal.org'];
export function allowedSourceUrl(raw:string):boolean{try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port||!SOURCE_HOSTS.includes(u.hostname))return false;if(u.hostname==='www.criterion.com'&&!u.pathname.startsWith('/current/posts/'))return false;return true}catch{return false}}
export function normalizedText(text:string){return text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');}
export function supports(text:string,span:string,titles:string[]){const haystack=normalizedText(text);return span.trim().length>=20&&haystack.includes(normalizedText(span))&&titles.length>0&&titles.every(t=>normalizedText(t).length>2&&normalizedText(span).includes(normalizedText(t)));}
export async function readSource(url:string,budget:Budget,signal:AbortSignal):Promise<string|null>{
 try{let current=url;for(let redirect=0;redirect<3;redirect++){
  if(!allowedSourceUrl(current)||budget.remaining--<=0)return null;
  const res=await fetch(current,{redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(7000)]),headers:{Accept:'text/html','User-Agent':'CLOSEUP/1.0 (film research)'}});
  if(res.status>=300&&res.status<400){const loc=res.headers.get('location');await res.body?.cancel();if(!loc)return null;current=new URL(loc,current).href;continue;}
  if(!res.ok||!(res.headers.get('content-type')??'').includes('text/html')){await res.body?.cancel();return null;}
  const reader=res.body?.getReader();if(!reader)return null;let bytes=0;let html='';const decoder=new TextDecoder();
  while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>400_000){await reader.cancel();return null;}html+=decoder.decode(chunk.value,{stream:true});}
  const clean=html.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi,' ');
  let text='';const transformed=new HTMLRewriter().on('*',{text(chunk){text+=chunk.text+' ';}}).transform(new Response(clean));await transformed.arrayBuffer();
  return text.replace(/\s+/g,' ').trim();
 }return null;}catch{return null;}
}
