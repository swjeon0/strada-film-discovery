import {MAX_SEEN_FILMS,MAX_SESSION_SNAPSHOTS,type Film,type Session} from './domain';

export type DiscoveredFilm=Pick<Film,'id'|'title'|'year'|'director'>;
export const MAX_DISCOVERED_FILMS=MAX_SESSION_SNAPSHOTS*12;
export {MAX_SEEN_FILMS} from './domain';

/** Only the branch through the current cursor belongs to the next discovery. */
export function discoveryHistoryContext(session:Pick<Session,'snapshots'|'cursor'|'archivedSeenIds'>,continuing:boolean):{discoveredFilms:DiscoveredFilm[],seenIds:string[]}{
 if(!continuing)return {discoveredFilms:[],seenIds:[]};
 const films=new Map<string,DiscoveredFilm>();
 const seen=new Set(session.archivedSeenIds??[]);
 for(const snapshot of session.snapshots.slice(0,session.cursor+1)){
  for(const {film} of snapshot.recommendations){
   if(!films.has(film.id))films.set(film.id,{id:film.id,title:film.title,year:film.year,director:film.director});
   seen.add(film.id);
  }
 }
 // Old snapshot details may expire, but their IDs remain excluded on this branch.
 if(films.size>MAX_DISCOVERED_FILMS||seen.size>MAX_SEEN_FILMS)throw new Error('This discovery history exceeds the supported path length.');
 return {discoveredFilms:[...films.values()],seenIds:[...seen]};
}
