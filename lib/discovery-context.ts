import type {Film,Session} from './domain';

export type DiscoveredFilm=Pick<Film,'id'|'title'|'year'|'director'>;
export const MAX_DISCOVERED_FILMS=400;

/** Only the branch through the current cursor belongs to the next discovery. */
export function discoveryHistoryContext(session:Pick<Session,'snapshots'|'cursor'>,continuing:boolean):{discoveredFilms:DiscoveredFilm[],seenIds:string[]}{
 if(!continuing)return {discoveredFilms:[],seenIds:[]};
 const films=new Map<string,DiscoveredFilm>();
 for(const snapshot of session.snapshots.slice(0,session.cursor+1)){
  for(const {film} of snapshot.recommendations){
   if(!films.has(film.id))films.set(film.id,{id:film.id,title:film.title,year:film.year,director:film.director});
  }
 }
 // A valid session has at most 31 × 12 = 372 films. Never silently drop older films.
 if(films.size>MAX_DISCOVERED_FILMS)throw new Error('This discovery history exceeds the supported path length.');
 return {discoveredFilms:[...films.values()],seenIds:[...films.keys()]};
}
