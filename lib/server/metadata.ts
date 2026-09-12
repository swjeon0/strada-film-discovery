import {titleMatches} from './grounding';
import {config,AppError} from './config';
import {getFilm as getTmdb,searchTMDB,resolveCandidate as resolveTmdb,type Budget} from './tmdb';
import {getWikimediaFilm,getWikimediaFilms,searchWikimedia,enrichWikipedia,resolveWikimediaCandidate} from './wikimedia';
import {filmById,collection} from '../catalogue';
import type {Film,Language} from '../domain';
export function canonicalFilm(film:Film){return collection.find(f=>f.wikidataId&&f.wikidataId===film.wikidataId)??film;}
export async function searchFilms(query:string,language:Language,budget?:Budget){
 const found=config().tmdb?await searchTMDB(query,budget,language):await searchWikimedia(query,language,budget);return [...new Map(found.map(f=>{const c=canonicalFilm(f);return [c.id,c]})).values()];
}
export async function getFilm(id:string,budget?:Budget):Promise<Film>{const known=filmById(id);if(known)return known;if(id.startsWith('wd:'))return canonicalFilm(await getWikimediaFilm(id,budget));if(id.startsWith('tmdb:'))return getTmdb(id,budget);throw new AppError('INVALID_FILM','This film could not be identified.',400);}
export async function getFilms(ids:string[],budget?:Budget){const wd=ids.filter(id=>id.startsWith('wd:'));const wikidata=wd.length?await getWikimediaFilms(wd,budget):[];const out:Film[]=[];for(const id of ids)out.push(id.startsWith('wd:')?canonicalFilm(wikidata.find(f=>f.id===id)!):await getFilm(id,budget));return out;}
export async function getFilmDetails(id:string,language:Language,budget?:Budget){const film=await getFilm(id,budget);if(film.wikidataId){const enriched=await enrichWikipedia(film,language,budget);return enriched;}return film;}
export async function resolveCandidate(title:string,year:number,director:string,budget:Budget){const local=collection.find(f=>titleMatches(f.title,title)&&Math.abs(f.year-year)<=1&&f.director.toLowerCase()===director.toLowerCase());if(local)return local;return canonicalNullable(config().tmdb?await resolveTmdb(title,year,director,budget):await resolveWikimediaCandidate(title,year,director,budget));}
function canonicalNullable(f:Film|null){return f?canonicalFilm(f):null;}
