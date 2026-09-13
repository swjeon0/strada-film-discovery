import {titleMatches} from './grounding';
import {config,AppError} from './config';
import {filmById,collection} from '../catalogue';
import type {Film,Language} from '../domain';
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
export async function searchTMDB(query:string,budget?:Budget,language:Language='en'){const data=await tmdb(`/search/movie?query=${encodeURIComponent(query)}&include_adult=false&language=${language==='ko'?'ko-KR':'en-US'}&page=1`,budget);return (data.results??[]).filter((f:any)=>f.release_date&&f.title).slice(0,8).map((r:any)=>language==='ko'?{...basic(r),title:r.original_title||r.title,titleKo:r.title}:basic(r)) as Film[];}
export async function getFilm(id:string,budget?:Budget):Promise<Film>{const local=filmById(id);if(local)return local;if(!/^tmdb:[1-9]\d*$/.test(id))throw new AppError('INVALID_FILM','This film could not be identified.',400);const data=await tmdb(`/movie/${id.slice(5)}?append_to_response=credits,translations`,budget);const directors=(data.credits?.crew??[]).filter((x:any)=>x.job==='Director').map((x:any)=>x.name);const ko=(data.translations?.translations??[]).find((t:any)=>t.iso_639_1==='ko')?.data;const titleKo=ko?.title||(data.original_language==='ko'?data.original_title:undefined)||undefined;const full={...basic(data),originalTitle:data.original_title,titleKo,titleKoSource:titleKo?`https://www.themoviedb.org/movie/${id.slice(5)}`:undefined,overviewEn:data.overview||undefined,synopsisEn:data.overview||undefined,overviewKo:ko?.overview||undefined,synopsisKo:ko?.overview||undefined,synopsisEnSource:`https://www.themoviedb.org/movie/${id.slice(5)}`,synopsisKoSource:ko?.overview?`https://www.themoviedb.org/movie/${id.slice(5)}`:undefined,genres:(data.genres??[]).map((g:any)=>String(g.id)),director:directors.join(', '),runtime:data.runtime,country:(data.production_countries??[]).map((x:any)=>x.name).join(' / ')};return collection.find(f=>norm(f.title)===norm(full.title)&&f.year===full.year&&norm(f.director)===norm(full.director))??full;}
const norm=(s:string)=>s.toLowerCase().normalize('NFKD').replace(/[\p{M}\p{P}\s]/gu,'');
export async function resolveCandidate(title:string,year:number,director:string,budget:Budget):Promise<Film|null>{
 const local=(await import('../catalogue')).collection.find(f=>norm(f.title)===norm(title)&&f.year===year&&norm(f.director)===norm(director));if(local)return local;
 if(!norm(director))return null;
 // Filter by year before limiting results: common titles otherwise push the right film past the first eight hits.
 const data=await tmdb(`/search/movie?query=${encodeURIComponent(title)}&year=${year}&include_adult=false&language=en-US&page=1`,budget);
 let hits=(data.results??[]).filter((r:any)=>r.release_date&&r.title).slice(0,12).map(basic) as Film[];
 if(!hits.length)hits=await searchTMDB(title,budget);
 const sameYear=hits.filter(f=>Math.abs(f.year-year)<=1);
 const exact=sameYear.filter(f=>titleMatches(f.title,title));
 const choices=exact.length?exact:sameYear;
 if(!choices.length||choices.length>4)return null;
 const verified:Film[]=[];
 for(const hit of choices){const full=await getFilm(hit.id,budget);if(norm(full.director)===norm(director)||full.director.split(',').some(d=>norm(d)===norm(director)))verified.push(full);}
 // A DB search can match a documented alternative title. The year and director still have to identify a unique film.
 return verified.length===1?verified[0]:null;
}
