import {safePoster} from '@/lib/domain';
export async function GET(request:Request){
 const url=new URL(request.url).searchParams.get('url')??'';
 if(!url.startsWith('https://')||!safePoster(url))return new Response('Invalid image',{status:400});
 const cache=typeof caches==='undefined'?undefined:(caches as CacheStorage&{default?:Cache}).default;
 const key=new Request(request.url);const hit=cache?await cache.match(key).catch(()=>undefined):undefined;if(hit)return hit;
 try{
  const upstream=await fetch(url,{redirect:'manual',headers:{Accept:'image/avif,image/webp,image/png,image/jpeg','User-Agent':'STRADA/2.0 (film discovery)'},signal:AbortSignal.timeout(8000)});
  const mime=(upstream.headers.get('content-type')??'').split(';')[0];
  if(!upstream.ok||!['image/jpeg','image/png','image/webp','image/avif'].includes(mime)){await upstream.body?.cancel();return new Response('Image unavailable',{status:404});}
  const reader=upstream.body!.getReader();const chunks:Uint8Array[]=[];let size=0;
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2_000_000){await reader.cancel();return new Response('Image too large',{status:413});}chunks.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const response=new Response(bytes,{headers:{'Content-Type':mime,'Cache-Control':'public,max-age=86400,s-maxage=86400,stale-while-revalidate=604800','X-Content-Type-Options':'nosniff'}});if(cache)await cache.put(key,response.clone()).catch(()=>{});return response;
 }catch{return new Response('Image unavailable',{status:502});}
}
