import {criticalPlan,usableDecision} from './critical-plan';
import {writeCuratedExplanations} from './curation-writing';
import type {DiscoveredFilm} from '../discovery-context';
import {RECOMMENDATION_COUNT,discoveryCacheKey,selectFreshRecommendations,validateFreshRecommendations} from '../recommendation-policy';
import {titleOf,type Film,type Batch,type Source,type Recommendation,type ResearchOptions} from '../domain';
import {CuratedFilm,EvidenceNote,CURATOR_DRAFT_PROMPT} from '../curation-contract';
import {config,AppError} from './config';
import {normalizedText} from './grounding';
import {emptyUsage,sumUsage,type Reference,type ResearchUsage} from './source-search';
import {prepareResearch,eligiblePreparedCandidates,selectedInput,type DiscoveryTimings} from './preparation';
import {issuePreparationToken} from './preparation-token';
import {curationSettings} from './curation-settings';
import {issueDetailToken} from './curation-detail';
import {localizeTitles} from '../i18n';

export const RESEARCH_PROMPT=CURATOR_DRAFT_PROMPT;
export type ResearchResult={batch:Batch,seeds:Film[],trail:Film[],usage:ResearchUsage,timings:DiscoveryTimings};
const completed=new Map<string,{at:number,value:ResearchResult,requestedIds:string[]}>();
type ResearchJob={promise:Promise<ResearchResult>,controller:AbortController,subscribers:number,settled:boolean,requestedIds:string[]};
const inFlight=new Map<string,ResearchJob>();

export async function research(seedIds:string[],trailIds:string[],signal:AbortSignal,seenIds:string[]=[],discoveredFilms:DiscoveredFilm[]=[],options:ResearchOptions={intent:trailIds.length?'follow':'initial',previousIds:[],language:'en'}):Promise<ResearchResult>{
 signal.throwIfAborted();
 const allSeen=[...new Set([...seenIds,...discoveredFilms.map(f=>f.id)])];
 const key=discoveryCacheKey(curationSettings().fingerprint,seedIds,trailIds,discoveredFilms,options,allSeen),old=completed.get(key);
 const ordered=(result:ResearchResult,requestedIds:string[])=>{const responseFilms=[...result.seeds,...result.trail],films=new Map(requestedIds.map((id,index)=>[id,responseFilms[index]]));return {...result,seeds:seedIds.map(id=>films.get(id)!),trail:trailIds.map(id=>films.get(id)!)};};
 if(old&&Date.now()-old.at<1_800_000)return ordered({...old.value,timings:{...old.value.timings,metadataMs:0,anchorResearchMs:0,draftMs:0,candidateResolutionMs:0,focusedResearchMs:0,prepareMs:0,selectionMs:0,writingMs:0,totalMs:0,preparationReused:true},usage:{...emptyUsage(old.value.usage.model),cached:true}},old.requestedIds);
 let job=inFlight.get(key);if(job?.controller.signal.aborted){inFlight.delete(key);job=undefined;}
 if(!job){const controller=new AbortController();const created:ResearchJob={promise:runResearch(seedIds,trailIds,allSeen,discoveredFilms,options,controller.signal),controller,subscribers:0,settled:false,requestedIds:[...seedIds,...trailIds]};job=created;inFlight.set(key,created);
  void created.promise.then(value=>{created.settled=true;if(!controller.signal.aborted){if(completed.size>=30)completed.delete(completed.keys().next().value!);completed.set(key,{at:Date.now(),value,requestedIds:created.requestedIds});}},()=>{created.settled=true;}).finally(()=>{if(inFlight.get(key)===created)inFlight.delete(key);});
 }
 job.subscribers++;try{return ordered(await waitForRequest(job.promise,signal),job.requestedIds);}finally{job.subscribers--;if(!job.subscribers&&!job.settled)job.controller.abort(new DOMException('The discovery request was canceled.','AbortError'));}
}
async function waitForRequest<T>(job:Promise<T>,signal:AbortSignal){
 if(signal.aborted)throw signal.reason;let abort=()=>{};
 try{return await Promise.race([job,new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}
}
function supportsPassage(ref:Reference,passage:string){const needle=normalizedText(passage);return needle.length>=25&&normalizedText(ref.text).includes(needle);}
async function runResearch(seedIds:string[],trailIds:string[],seenIds:string[],discoveredFilms:DiscoveredFilm[],options:ResearchOptions,requestSignal:AbortSignal):Promise<ResearchResult>{
 const conf=config();if(!conf.openai)throw new AppError('SETUP_REQUIRED','AI discovery is not connected.',503);
 const started=Date.now(),deadline=started+90_000,signal=AbortSignal.any([requestSignal,AbortSignal.timeout(90_000)]);
 const prepared=await prepareResearch(seedIds,trailIds,signal,seenIds,discoveredFilms,options);
 const {preparation,seeds,trail}=prepared,films=[...seeds,...trail],selectedIds=films.map(f=>f.id);
 let usage=prepared.usage;
 const anchorInput=selectedInput(films,options.language),filmMap=new Map(films.map(f=>[f.id,f])),anchors=new Map(anchorInput.map(a=>[a.code,{film:filmMap.get(a.id)!}]));
 const lenses=new Map(preparation.lenses.map(l=>[l.id,l]));
 const verified=eligiblePreparedCandidates(preparation,seenIds,options);
 const references=new Map(preparation.references.map((reference,i)=>[`s${i}`,reference]));
 const byCode=new Map(verified.map(row=>[row.code,row]));
 const selectionStarted=Date.now();
 const decisionReused=!!usableDecision(preparation,films,seenIds,options);
 let ranking=verified.map(row=>row.code),rejected=new Set<string>(),curated=new Map<string,ReturnType<typeof CuratedFilm.parse>>(),curationFallback=false;
 try{
  const saved=usableDecision(preparation,films,seenIds,options);
  const selected=saved?{decision:saved,usage:{...emptyUsage(curationSettings().stages.curate.model),cached:true}}:await criticalPlan(preparation,films,seenIds,options,signal,Math.min(40000,Math.max(1,deadline-Date.now()-19000)));
  usage=sumUsage(usage,selected.usage);
  ranking=selected.decision.ranking;rejected=new Set(selected.decision.rejected);
  curated=new Map(selected.decision.recommendations.map(row=>[row.candidate,row]));

 }catch(error){if(requestSignal.aborted)throw requestSignal.reason;curationFallback=true;console.warn('STRADA final curation fallback',{error:error instanceof AppError?error.code:error instanceof Error?error.name:'unknown'});}
 const selectionMs=Date.now()-selectionStarted;
 let writingMs=0,writingFallback=false;
 if(curated.size){
  // Expand only approved rows that can survive the hard identity/freshness rules.
  const proposed=ranking.filter(code=>!rejected.has(code)).map(code=>({film:byCode.get(code)!.film}) as Recommendation);
  const actualIds=new Set(selectFreshRecommendations(proposed,selectedIds,seenIds,options.previousIds,options.intent,RECOMMENDATION_COUNT).map(rec=>rec.film.id));
  const selectedPlans=new Map([...curated].filter(([code])=>actualIds.has(byCode.get(code)!.film.id)));
  try{const written=await writeCuratedExplanations(selectedPlans,verified,films,references,options.language,AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,deadline-Date.now()-500))]));for(const [code,row] of written.curated)curated.set(code,row);usage=sumUsage(usage,written.usage);writingMs=written.writingMs;writingFallback=written.fallback;}
  catch(error){if(requestSignal.aborted)throw requestSignal.reason;writingFallback=true;console.warn('STRADA explanation writing fallback',{error:error instanceof Error?error.name:'unknown'});}
 }

 const sources=new Map<string,Source>();
 const recommendations:Recommendation[]=ranking.filter(code=>!rejected.has(code)).map(code=>{
  const verifiedFilm=byCode.get(code)!,row=curated.get(code),plan=verifiedFilm.draft;
  const anchorCodes=[...new Set((row?.anchors??plan.anchors).filter(a=>anchors.has(a)))];if(!anchorCodes.length)anchorCodes.push(plan.anchors.find(a=>anchors.has(a))!);
  const localize=(text:string)=>localizeTitles(text.replace(/\b(?:a|c)\d+\b/g,code=>{const film=anchors.get(code)?.film??byCode.get(code)?.film;return film?titleOf(film,options.language):code;}),[...films,...verified.map(v=>v.film)],options.language);
  const sourceIds:string[]=[];
  for(const value of row?.evidence??[]){const parsed=EvidenceNote.safeParse(value);if(!parsed.success)continue;const note=parsed.data,reference=references.get(note.ref);if(!reference||!supportsPassage(reference,note.passage)||!note.point)continue;
   const id=`ref:${note.ref}:${code}`;if(sourceIds.includes(id))continue;sources.set(id,{...reference.source,id,scope:'interpretive_context',excerpt:note.passage,summary:localize(note.point),...options.language==='ko'?{summaryKo:localize(note.point)}:{}});sourceIds.push(id);
  }
  const why=localize(row?.why||[plan.bridge,plan.contrast].filter(Boolean).join(' '));
  return {film:verifiedFilm.film,sourceIds,contextScope:sourceIds.length?undefined:'discovery',curation:{lens:localize(row?.lens||lenses.get(plan.lens)!.label),bridge:localize(row?.bridge||plan.bridge),contrast:localize(row?.contrast||plan.contrast)},connections:anchorCodes.map((anchorCode,index)=>{const anchor=anchors.get(anchorCode)!.film;const ids=index===0?sourceIds:[];return {anchorId:anchor.id,anchorTitle:anchor.title,relation:ids.length?'grounded_interpretation' as const:'ai_inference' as const,why,...options.language==='ko'?{whyKo:why}:{},sourceIds:ids};})};
 });
 const fresh=selectFreshRecommendations(recommendations,selectedIds,seenIds,options.previousIds,options.intent,RECOMMENDATION_COUNT);
 const validation=validateFreshRecommendations(fresh,selectedIds,seenIds,options.previousIds,options.intent,RECOMMENDATION_COUNT,false);
 if(!validation.valid)throw new AppError('NO_NEW_FILMS','More new films could not be found. Your path is unchanged.');
 const used=new Set(fresh.flatMap(rec=>rec.sourceIds)),usedSources=[...sources.values()].filter(source=>used.has(source.id));
 for(const rec of fresh)rec.detailToken=issueDetailToken(rec,films,usedSources);
 const shown=new Set(fresh.map(rec=>rec.film.id));
 // Only retain still-unseen, non-rejected candidates; final curation still runs on reuse.
 const reserve=verified.filter(row=>!shown.has(row.film.id)&&!seenIds.includes(row.film.id)&&!rejected.has(row.code));
 const preparationToken=issuePreparationToken({...preparation,decision:undefined,candidates:reserve});
 const timings={...prepared.timings,selectionMs,decisionReused,writingMs,totalMs:Date.now()-started};
 requestSignal.throwIfAborted();
 console.info('STRADA curation audit',{elapsedMs:Date.now()-started,intent:options.intent,selectedCount:films.length,proposed:preparation.candidates.length,verified:verified.length,references:references.size,count:fresh.length,sourced:fresh.filter(r=>r.sourceIds.length).length,fresh:validation.freshCount,overlap:validation.overlapCount,curationFallback,writingFallback,reserveCount:reserve.length,timings,usage});
 return {batch:{recommendations:fresh,sources:usedSources,mode:'live',preparationToken,reserveCount:reserve.length,...(fresh.length<RECOMMENDATION_COUNT?{notice:'partial' as const}:{})},seeds,trail,usage,timings};
}
