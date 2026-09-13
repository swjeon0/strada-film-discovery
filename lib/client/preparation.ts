import type {Film,Language,ResearchIntent,Session} from '../domain';
import {discoveryHistoryContext,type DiscoveredFilm} from '../discovery-context';

export type PreparationInput={requestId:string;baseSnapshotId:string|null;seeds:string[];trail:string[];language:Language;intent:ResearchIntent;previousIds:string[];seenIds:string[];discoveredFilms:DiscoveredFilm[];preparationToken?:string};
export type PreparationResult={preparationToken:string;reserveCount:number};

export function discoveryInput(session:Session,language:Language,intent:ResearchIntent,film?:Film):PreparationInput{
 const base=session.snapshots[session.cursor],continuing=intent!=='initial';
 const seeds=continuing?base?.seeds??[]:session.seedDraft,trail=continuing?[...base?.trail??[]]:[];
 if((intent==='follow'||intent==='manual')&&film)trail.push(film);
 return {requestId:crypto.randomUUID(),baseSnapshotId:base?.id??null,seeds:seeds.map(f=>f.id),trail:trail.map(f=>f.id),language,intent,previousIds:continuing?base?.recommendations.map(r=>r.film.id)??[]:[],...(continuing&&base?.preparationToken?{preparationToken:base.preparationToken}:{}),...discoveryHistoryContext(session,continuing)};
}

/** Reuse only the exact selected path, exclusion history, language, and action. */
export function preparationKey(input:PreparationInput){
 return JSON.stringify([input.baseSnapshotId,input.language,input.intent,[...input.seeds].sort(),[...input.trail].sort(),[...input.previousIds].sort(),[...input.seenIds].sort(),[...input.discoveredFilms].sort((a,b)=>a.id.localeCompare(b.id))]);
}

type Entry={controller:AbortController;adopted:boolean;pending:boolean;promise:Promise<PreparationResult|undefined>};

/** A small per-tab pool: at most one speculative request, never a committed result. */
export class PreparationManager{
 private entries=new Map<string,Entry>();
 private suppressed=new Set<string>();
 constructor(private request:typeof fetch=(...args)=>fetch(...args)){}
 prepare(input:PreparationInput):Promise<PreparationResult|undefined>{
  const key=preparationKey(input),existing=this.entries.get(key);
  if(this.suppressed.has(key))return Promise.resolve(undefined);
  if(existing)return existing.promise;
  this.cancelUnadopted();
  const controller=new AbortController();
  const entry:Entry={controller,adopted:false,pending:true,promise:Promise.resolve(undefined)};
  entry.promise=this.request('/api/recommendations/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(95000)])}).then(async response=>{
   if(!response.ok||controller.signal.aborted)return;
   const data=await response.json() as Partial<PreparationResult>&{requestId?:string;baseSnapshotId?:string|null};
   if(controller.signal.aborted||data.requestId!==input.requestId||data.baseSnapshotId!==input.baseSnapshotId||typeof data.preparationToken!=='string'||!data.preparationToken.length||data.preparationToken.length>220000||!Number.isInteger(data.reserveCount)||data.reserveCount!<0||data.reserveCount!>32)return;
   return {preparationToken:data.preparationToken,reserveCount:data.reserveCount!};
  }).catch(()=>undefined).then(result=>{
   entry.pending=false;
   if(!result&&this.entries.get(key)===entry)this.entries.delete(key);
   return result;
  });
  this.entries.set(key,entry);
  while(this.entries.size>3){const oldest=[...this.entries].find(([id,item])=>id!==key&&!item.pending);if(!oldest)break;this.entries.delete(oldest[0]);}
  return entry.promise;
 }
 /** Mark adoption synchronously, before React's pending-state cleanup runs. */
 adopt(input:PreparationInput,signal:AbortSignal):Promise<PreparationResult|undefined>{
  const key=preparationKey(input),entry=this.entries.get(key);
  this.suppressed.delete(key);
  if(!entry||signal.aborted)return Promise.resolve(undefined);
  entry.adopted=true;
  const abort=()=>{entry.controller.abort();if(this.entries.get(key)===entry)this.entries.delete(key);};
  signal.addEventListener('abort',abort,{once:true});
  return entry.promise.finally(()=>signal.removeEventListener('abort',abort));
 }
 suppress(key:string){this.suppressed.add(key);while(this.suppressed.size>3)this.suppressed.delete(this.suppressed.values().next().value!);}
 cancelUnadopted(){for(const [key,entry] of this.entries)if(entry.pending&&!entry.adopted){entry.controller.abort();this.entries.delete(key);}}
 clear(){for(const entry of this.entries.values())entry.controller.abort();this.entries.clear();this.suppressed.clear();}
}
