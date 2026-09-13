"use client";
import {useState} from 'react';
import {safePoster,type Film} from '@/lib/domain';
export function FilmPoster({film,decorative=false,onAvailabilityChange}:{film:Film,decorative?:boolean,onAvailabilityChange?:(available:boolean)=>void}){
 const url=safePoster(film.poster);const [failure,setFailure]=useState<{url:string,stage:number}>({url:'',stage:0});
 const stage=failure.url===url?failure.stage:0;
 const src=stage===1&&url.startsWith('https://')?`/api/poster?url=${encodeURIComponent(url)}`:url;
 return src&&stage<2?<img src={src} alt={decorative?'':film.title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={()=>onAvailabilityChange?.(true)} onError={()=>{const next=url.startsWith('https://')?stage+1:2;setFailure({url,stage:next});if(next>=2)onAvailabilityChange?.(false);}}/>:<span className="poster-fallback" role={decorative?undefined:'img'} aria-label={decorative?undefined:`Poster unavailable for ${film.title}`}><span>{film.title}</span><small>{film.year}</small></span>;
}
