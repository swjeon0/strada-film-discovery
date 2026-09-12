import {config,AppError} from './config';
import {filmById,collection} from '../catalogue';
import type {Film} from '../domain';
const cache=new Map<string,{at:number,value:unknown}>();
export type Budget={remaining:number,signal?:AbortSignal};
export async function tmdb(path:string,budget?:Budget):Promise<any>{
 const cached=cache.get(path);if(cached&&Date.now()-cached.at<600_000)return cached.value;
 if(budget&&budget.remaining--<=0)throw new AppError('BUDGET','This trail needs more research than one request allows. Try fewer starting films.');
 const token=config().tmdb;if(!token)throw new AppError('SETUP_REQUIRED','Live movie search is not connected. The reference collection is available.',503);
 const res=await fetch(`https://api.themoviedb.org/3${path}`,{headers:{Authorization:`Bearer ${token}`,accept:'application/json'},signal:budget?.signal?AbortSignal.any([budget.signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
 if(!res.ok)throw new AppError(res.status===429?'RATE_LIMIT':'METADATA_ERROR',res.status===429?'Film search is busy. Please try again shortly.':'Film search is temporarily unavailable.',res.status===429?429:502);
 const value=await res.json();if(cache.size>200)cache.delete(cache.keys().next().value!);cache.set(path,{at:Date.now(),value});return value;
}
function basic(r:any):Film{return {id:`tmdb:${r.id}`,title:r.title,year:Number(r.release_date?.slice(0,4))||1900,director:'',poster:r.poster_path?`https://image.tmdb.org/t/p/w500${r.poster_path}`:''};}
export async function searchTMDB(query:string,budget?:Budget){const data=await tmdb(`/search/movie?query=${encodeURIComponent(query)}&include_adult=false&language=en-US&page=1`,budget);return (data.results??[]).filter((f:any)=>f.release_date&&f.title).slice(0,6).map(basic) as Film[];}
export async function getFilm(id:string,budget?:Budget):Promise<Film>{const local=filmById(id);if(local)return local;if(!/^tmdb:[1-9]\d*$/.test(id))throw new AppError('INVALID_FILM','This film could not be identified.',400);const data=await tmdb(`/movie/${id.slice(5)}?append_to_response=credits`,budget);const directors=(data.credits?.crew??[]).filter((x:any)=>x.job==='Director').map((x:any)=>x.name);const full={...basic(data),director:directors.join(', '),runtime:data.runtime,country:(data.production_countries??[]).map((x:any)=>x.name).join(' / ')};return collection.find(f=>norm(f.title)===norm(full.title)&&f.year===full.year&&norm(f.director)===norm(full.director))??full;}
const norm=(s:string)=>s.toLowerCase().normalize('NFKD').replace(/[\p{M}\p{P}\s]/gu,'');
export async function resolveCandidate(title:string,year:number,director:string,budget:Budget):Promise<Film|null>{
 const local=(await import('../catalogue')).collection.find(f=>norm(f.title)===norm(title)&&f.year===year&&norm(f.director)===norm(director));if(local)return local;
 if(!norm(director))return null;
 const hits=await searchTMDB(title,budget);const exact=hits.filter(f=>norm(f.title)===norm(title)&&Math.abs(f.year-year)<=1);if(!exact.length||exact.length>2)return null;
 for(const hit of exact){const full=await getFilm(hit.id,budget);if(norm(full.director)===norm(director)||full.director.split(',').some(d=>norm(d)===norm(director)))return full;}return null;
}
