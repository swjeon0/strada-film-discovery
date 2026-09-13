import type {Film} from '../domain';
import {config} from './config';
import {emptyUsage,findCuratorialReferences,sumUsage,type Reference,type ResearchUsage} from './source-search';
import type {Budget} from './tmdb';

const CACHE_TTL_MS=86_400_000;
const MAX_CACHED_FILMS=160;
const MAX_CONCURRENT_FILMS=4;
const DEADLINE_MS=15_000;
const DOCUMENT_BUDGET_PER_FILM=8;
type FilmResearch={references:Reference[];usage:ResearchUsage};
type SharedResearch={promise:Promise<FilmResearch>;controller:AbortController;subscribers:number;settled:boolean;usageClaimed:boolean};
const completed=new Map<string,{at:number;references:Reference[]}>();
const inFlight=new Map<string,SharedResearch>();
const lastAttempt=new Map<string,number>();
let attemptSequence=0;

export type AnchorResearchResult={
 references:Reference[];
 usage:ResearchUsage;
 elapsedMs:number;
 /** Selected films represented by an actual, readable reference in this result. */
 coveredFilmIds:string[];
 /** Selected films for which this request joined or started retrieval. */
 searchedFilmIds:string[];
 cachedFilmIds:string[];
 /** Uncovered films deferred by the four-film concurrency or request budget. */
 deferredFilmIds:string[];
};

function cacheKey(film:Film,model:string){return JSON.stringify([model,film.id,film.title,film.originalTitle,film.titleKo,film.year,film.director]);}
function rememberAttempt(key:string){
 if(lastAttempt.size>=MAX_CACHED_FILMS*2&&!lastAttempt.has(key))lastAttempt.delete(lastAttempt.keys().next().value!);
 lastAttempt.set(key,++attemptSequence);
}
function mergeReferences(references:Reference[]){
 const unique=new Map<string,Reference>();
 for(const reference of references){
  const old=unique.get(reference.source.url);
  unique.set(reference.source.url,old?{...old,anchorIds:[...new Set([...old.anchorIds,...reference.anchorIds])],text:old.text===reference.text?old.text:[old.text,reference.text].join('\n\n').slice(0,9000)}:reference);
 }
 return [...unique.values()];
}
/** Read only already-validated, unexpired selected-film passages; never starts work. */
export function peekAnchorReferences(films:Film[]):Reference[]{
 const model=config().searchModel,references:Reference[]=[];
 for(const film of [...new Map(films.map(item=>[item.id,item])).values()].sort((a,b)=>a.id.localeCompare(b.id))){
  const old=completed.get(cacheKey(film,model));
  if(old&&Date.now()-old.at<CACHE_TTL_MS)references.push(...old.references);
 }
 // Prompt assembly may shorten an excerpt. Keep the reusable cache independent
 // of such caller edits, including edits to nested source metadata/anchor IDs.
 return structuredClone(mergeReferences(references));
}
async function waitForSubscriber<T>(promise:Promise<T>,signal:AbortSignal){
 signal.throwIfAborted();let abort=()=>{};
 try{return await Promise.race([promise,new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason??new DOMException('Canceled','AbortError'));signal.addEventListener('abort',abort,{once:true});})]);}
 finally{signal.removeEventListener('abort',abort);}
}
function createJob(film:Film,key:string,budget:Budget){
 const controller=new AbortController();
 const allowance=Math.min(DOCUMENT_BUDGET_PER_FILM,Math.max(0,budget.remaining));
 // Reserve the whole allowance before concurrent jobs start. Return unused units
 // when settled; joining callers do not consume another document budget.
 budget.remaining-=allowance;
 const filmBudget:Budget={remaining:allowance};
 const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(DEADLINE_MS)]);
 rememberAttempt(key);
 const promise=findCuratorialReferences([film],[{
  query:`${film.title} (${film.year}), ${film.director}: substantive criticism of cinematic form, framing, duration, sound and historical context. Search this film individually, including its original title ${film.originalTitle||film.title}${film.titleKo?` and Korean title ${film.titleKo}`:''}.`,
  filmIds:[film.id],purpose:'anchor',
 }],filmBudget,signal).then(result=>({...result,references:result.references.filter(reference=>reference.anchorIds.includes(film.id)).slice(0,2)})).finally(()=>{budget.remaining+=Math.max(0,filmBudget.remaining);});
 const job:SharedResearch={promise,controller,subscribers:0,settled:false,usageClaimed:false};
 inFlight.set(key,job);
 void promise.then(result=>{
  job.settled=true;
  if(!controller.signal.aborted&&result.references.length){
   if(completed.size>=MAX_CACHED_FILMS&&!completed.has(key))completed.delete(completed.keys().next().value!);
   completed.set(key,{at:Date.now(),references:result.references});
  }
 },()=>{job.settled=true;}).finally(()=>{if(inFlight.get(key)===job)inFlight.delete(key);});
 return job;
}

/**
 * Start as soon as selected-film metadata is ready, alongside the draft model.
 * Retrieval is per film, so regeneration and Follow reuse readings without
 * treating a newly selected film as more important than earlier selections.
 */
export async function prepareAnchorReferences(films:Film[],budget:Budget,callerSignal:AbortSignal):Promise<AnchorResearchResult>{
 callerSignal.throwIfAborted();
 const started=Date.now(),model=config().searchModel,signal=AbortSignal.any([callerSignal,AbortSignal.timeout(DEADLINE_MS)]);
 const unique=[...new Map(films.map(film=>[film.id,film])).values()].sort((a,b)=>a.id.localeCompare(b.id));
 const references:Reference[]=[],cachedFilmIds:string[]=[],missing:{film:Film;key:string}[]=[];
 for(const film of unique){
  const key=cacheKey(film,model),old=completed.get(key);
  if(old&&Date.now()-old.at<CACHE_TTL_MS){references.push(...old.references);cachedFilmIds.push(film.id);}
  else missing.push({film,key});
 }
 // Join existing work first. For longer paths, unsearched/oldest-attempted films
 // get the next slots regardless of the order in which the user added them.
 const priority=(key:string)=>inFlight.get(key)&&!inFlight.get(key)!.controller.signal.aborted?-1:lastAttempt.get(key)??0;
 missing.sort((a,b)=>priority(a.key)-priority(b.key)||a.film.id.localeCompare(b.film.id));
 let usage=emptyUsage(model);const searchedFilmIds:string[]=[],deferredFilmIds:string[]=[];
 const jobs:Promise<void>[]=[];
 for(const {film,key} of missing){
  if(jobs.length>=MAX_CONCURRENT_FILMS){deferredFilmIds.push(film.id);continue;}
  let job=inFlight.get(key);
  if(job?.controller.signal.aborted){inFlight.delete(key);job=undefined;}
  if(!job&&budget.remaining<=0){deferredFilmIds.push(film.id);continue;}
  job??=createJob(film,key,budget);
  const active=job;active.subscribers++;searchedFilmIds.push(film.id);
  jobs.push((async()=>{
   try{
    const result=await waitForSubscriber(active.promise,signal);references.push(...result.references);
    // Attribute one paid result exactly once, including when its first caller
    // leaves while another subscriber is still waiting for the same search.
    if(!active.usageClaimed){active.usageClaimed=true;usage=sumUsage(usage,result.usage);}
   }catch(error){if(callerSignal.aborted)throw error;/* Deadline/failure leaves the other completed readings usable. */}
   finally{active.subscribers--;if(!active.subscribers&&!active.settled)active.controller.abort(new DOMException('All anchor-research callers canceled.','AbortError'));}
  })());
 }
 await Promise.all(jobs);callerSignal.throwIfAborted();
 const merged=mergeReferences(references),covered=new Set(merged.flatMap(reference=>reference.anchorIds));
 const result={references:merged,usage,elapsedMs:Date.now()-started,coveredFilmIds:unique.filter(film=>covered.has(film.id)).map(film=>film.id),searchedFilmIds,cachedFilmIds,deferredFilmIds};
 console.info('STRADA selected-film research',{elapsedMs:result.elapsedMs,selected:unique.length,searched:searchedFilmIds.length,cached:cachedFilmIds.length,covered:result.coveredFilmIds.length,deferred:deferredFilmIds.length,references:merged.length,searchCalls:usage.searchCalls});
 return result;
}
