import type {Film} from './domain';
import type {DiscoveredFilm} from './discovery-context';

export const RECOMMENDATION_COUNT=12;
export const CANDIDATE_COUNT=24;
export function discoveryModelContext(selected:Film[],discovered:DiscoveredFilm[]){
 const unique=new Map<string,DiscoveredFilm>();
 for(const film of [...discovered,...selected])unique.set(film.id,{id:film.id,title:film.title,year:film.year,director:film.director});
 return [...unique.values()].sort((a,b)=>a.id.localeCompare(b.id)).map((film,i)=>({code:`d${i}`,...film,weight:1/unique.size}));
}
export function discoveryCacheKey(model:string,seedIds:string[],trailIds:string[],discovered:DiscoveredFilm[]){
 return JSON.stringify(['strada-v19-equal-history',model,seedIds,trailIds,discoveryModelContext([],discovered)]);
}
export function coversDiscoveryContext(basis:string[],context:{code:string}[]){
 const allowed=new Set(context.map(f=>f.code));
 return new Set(basis.filter(code=>allowed.has(code))).size>=Math.min(2,context.length);
}
// Source lookup has a finite cost budget. A set-dependent order avoids privileging addition time.
export function sourceSearchOrder(films:Film[]){
 const key=films.map(f=>f.id).sort().join('|');
 const score=(id:string)=>{let hash=2166136261;for(const c of key+'|'+id)hash=Math.imul(hash^c.charCodeAt(0),16777619);return hash>>>0;};
 return [...films].sort((a,b)=>score(a.id)-score(b.id)||a.id.localeCompare(b.id));
}
