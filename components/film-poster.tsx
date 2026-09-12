"use client";
import {useState} from 'react';
import {safePoster,type Film} from '@/lib/domain';
export function FilmPoster({film,decorative=false}:{film:Film,decorative?:boolean}){const [failed,setFailed]=useState(false);const url=safePoster(film.poster);return url&&!failed?<img src={url} alt={decorative?'':`${film.title} poster`} loading="lazy" onError={()=>setFailed(true)}/>:<span className="poster-fallback" role={decorative?undefined:'img'} aria-label={decorative?undefined:`Poster unavailable for ${film.title}`}><span>{film.title}</span><small>{film.year}</small></span>}
