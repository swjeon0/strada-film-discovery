import type {Film,Recommendation,ResearchIntent,ResearchOptions} from './domain';
import type {DiscoveredFilm} from './discovery-context';

export const RECOMMENDATION_COUNT=12;
export const CANDIDATE_COUNT=24;
export function discoveryModelContext(selected:Film[],discovered:DiscoveredFilm[]){
 // A displayed film is discovery history, not a statement of the user's taste.
 void discovered;
 const unique=new Map<string,DiscoveredFilm>();
 for(const film of selected)unique.set(film.id,{id:film.id,title:film.title,year:film.year,director:film.director});
 return [...unique.values()].sort((a,b)=>a.id.localeCompare(b.id)).map((film,i)=>({code:`d${i}`,...film,weight:1/unique.size}));
}
export function discoveryCacheKey(model:string,seedIds:string[],trailIds:string[],discovered:DiscoveredFilm[],options?:ResearchOptions,seenIds:string[]=[]){
 return JSON.stringify(['strada-v20-curation-freshness',model,[...seedIds].sort(),[...trailIds].sort(),[...new Set([...seenIds,...discovered.map(f=>f.id)])].sort(),options?{...options,previousIds:[...new Set(options.previousIds)].sort()}:null]);
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

export type FreshnessValidation={valid:boolean;issues:string[];freshCount:number;overlapCount:number};
const hasFreshnessFloor=(intent:ResearchIntent)=>intent==='follow'||intent==='manual';

/** Keep the curator's order and never trade a freshness constraint for filling a slot. */
export function selectFreshRecommendations(recs:Recommendation[],selectedIds:string[],seenIds:string[],previousIds:string[],intent:ResearchIntent,limit=RECOMMENDATION_COUNT):Recommendation[]{
 if(!Number.isInteger(limit)||limit<1)throw new Error('Recommendation limit must be a positive integer.');
 const excluded=new Set(selectedIds);
 if(intent==='regenerate')for(const id of [...seenIds,...previousIds])excluded.add(id);
 const previous=new Set(previousIds);
 const used=new Set<string>();
 let overlap=0;
 const maximumOverlap=Math.floor((limit-1)/2);
 const selected:Recommendation[]=[];
 for(const rec of recs){
  const id=rec.film.id;
  if(excluded.has(id)||used.has(id))continue;
  if(hasFreshnessFloor(intent)&&previous.has(id)&&overlap>=maximumOverlap)continue;
  selected.push(rec);used.add(id);
  if(previous.has(id))overlap++;
  if(selected.length===limit)break;
 }
 // With too few new candidates, return an honest shorter majority-new batch.
 // Remove the lowest-priority repeated films rather than disguising them as fresh.
 if(hasFreshnessFloor(intent)){
  for(let i=selected.length-1;i>=0&&overlap>=selected.length-overlap;i--){
   if(previous.has(selected[i].film.id)){selected.splice(i,1);overlap--;}
  }
 }
 return selected;
}

/** Shared API/UI check. Partial batches may relax count, never exclusions or majority. */
export function validateFreshRecommendations(recs:Recommendation[],selectedIds:string[],seenIds:string[],previousIds:string[],intent:ResearchIntent,limit=RECOMMENDATION_COUNT,requireComplete=true):FreshnessValidation{
 const selected=new Set(selectedIds),seen=new Set([...seenIds,...previousIds]),previous=new Set(previousIds);
 const ids=recs.map(rec=>rec.film.id),unique=new Set(ids);
 const overlapCount=ids.filter(id=>previous.has(id)).length;
 const freshCount=ids.length-overlapCount;
 const issues:string[]=[];
 if(!Number.isInteger(limit)||limit<1)issues.push('invalid_limit');
 if(!recs.length||recs.length>limit||(requireComplete&&recs.length!==limit))issues.push('incomplete_batch');
 if(unique.size!==ids.length)issues.push('duplicate_films');
 if(ids.some(id=>selected.has(id)))issues.push('selected_film');
 if(intent==='regenerate'&&ids.some(id=>seen.has(id)))issues.push('previously_seen_film');
 if(hasFreshnessFloor(intent)&&freshCount<=overlapCount)issues.push('insufficient_fresh_films');
 return {valid:issues.length===0,issues,freshCount,overlapCount};
}
