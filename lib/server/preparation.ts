import {createHash} from 'node:crypto';
import type {DiscoveredFilm} from '../discovery-context';
import {weights,titleOf,type Film,type ResearchOptions} from '../domain';
import {CuratorialCandidate,DraftSchema,curationDraftSchema,CURATOR_DRAFT_PROMPT} from '../curation-contract';
import {getFilms,resolveCandidates} from './metadata';
import {config,AppError} from './config';
import {curationSettings} from './curation-settings';
import {curatorResponse} from './curator-model';
import {prepareAnchorReferences,peekAnchorReferences} from './anchor-research';
import {normalizedText,filmMentioned} from './grounding';
import {emptyUsage,sumUsage,findCuratorialReferences,type ResearchUsage,type Reference,type CuratorialQuery} from './source-search';
import {issuePreparationToken,readPreparationToken,PREPARATION_TTL,type Preparation} from './preparation-token';

export type DiscoveryTimings={metadataMs:number;anchorResearchMs:number;draftMs:number;candidateResolutionMs:number;focusedResearchMs:number;prepareMs:number;selectionMs:number;writingMs?:number;decisionReused?:boolean;totalMs:number;preparationReused:boolean};
export type PreparedResult={preparation:Preparation;preparationToken?:string;seeds:Film[];trail:Film[];usage:ResearchUsage;timings:DiscoveryTimings};
type PreparedWork={preparation:Preparation;usage:ResearchUsage;timings:DiscoveryTimings};
const completed=new Map<string,{at:number,value:PreparedWork}>();
type Job={promise:Promise<PreparedWork>,controller:AbortController,subscribers:number,settled:boolean};
const inFlight=new Map<string,Job>();
export function preparationFingerprint(){const s=curationSettings();return createHash('sha256').update('strada-preparation-v1:'+s.stageFingerprints.draft+':'+s.stageFingerprints.search).digest('hex');}
export function selectedInput(films:Film[],language:ResearchOptions['language']){
 return weights(films,[]).sort((a,b)=>a.film.id.localeCompare(b.film.id)).map(({film,weight},i)=>({code:`a${i}`,id:film.id,title:film.title,titleKo:film.titleKo,displayTitle:titleOf(film,language),year:film.year,director:film.director,weight,overview:(film.overviewEn||film.synopsisEn||film.overviewKo||'').slice(0,1000),country:film.country}));
}
export function eligiblePreparedCandidates(preparation:Preparation,seenIds:string[],options:ResearchOptions){
 const excluded=new Set(preparation.selected.map(f=>f.id));if(options.intent==='regenerate')for(const id of [...seenIds,...options.previousIds])excluded.add(id);
 return preparation.candidates.filter(row=>!excluded.has(row.film.id));
}
function reusable(preparation:Preparation,seenIds:string[],options:ResearchOptions){
 const available=eligiblePreparedCandidates(preparation,seenIds,options);
 if(available.length<12)return false;
 return !['follow','manual'].includes(options.intent)||available.filter(row=>!options.previousIds.includes(row.film.id)).length>=7;
}
export async function prepareResearch(seedIds:string[],trailIds:string[],signal:AbortSignal,seenIds:string[]=[],discovered:DiscoveredFilm[]=[],options:ResearchOptions={intent:'initial',previousIds:[],language:'en'}):Promise<PreparedResult>{
 signal=AbortSignal.any([signal,AbortSignal.timeout(60000)]);
 signal.throwIfAborted();if(!config().openai)throw new AppError('SETUP_REQUIRED','AI discovery is not connected.',503);
 const started=Date.now(),films=await getFilms([...seedIds,...trailIds],{remaining:160,signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])}),metadataMs=Date.now()-started;
 if(!films.length||new Set(films.map(f=>f.id)).size!==films.length)throw new AppError('DUPLICATE_FILM','Choose distinct films for this path.',400);
 signal.throwIfAborted();
 const seeds=films.slice(0,seedIds.length),trail=films.slice(seedIds.length),fingerprint=preparationFingerprint();
 const supplied=readPreparationToken(options.preparationToken,films,options.language,fingerprint);
 const inherited=supplied??readPreparationToken(options.preparationToken,films,options.language,fingerprint,true);
 const pack=(value:PreparedWork,reused=false):PreparedResult=>({...value,seeds,trail,preparationToken:issuePreparationToken(value.preparation),usage:reused?{...emptyUsage(config().curatorModel),cached:true}:value.usage,timings:{...(reused?zeroTimings():value.timings),metadataMs,prepareMs:Date.now()-started,totalMs:Date.now()-started,preparationReused:reused}});
 if(supplied&&reusable(supplied,seenIds,options))return pack({preparation:supplied,usage:emptyUsage(),timings:zeroTimings()},true);
 const priorKey=inherited?createHash('sha256').update(JSON.stringify(inherited)).digest('hex'):null;
 const key=JSON.stringify([fingerprint,films.map(f=>f.id).sort(),options.language,options.intent,[...options.previousIds].sort(),[...new Set([...seenIds,...discovered.map(f=>f.id)])].sort(),priorKey]);
 const old=completed.get(key);if(old&&Date.now()-old.at<PREPARATION_TTL&&reusable(old.value.preparation,seenIds,options))return pack(old.value,true);
 let job=inFlight.get(key);if(job?.controller.signal.aborted){inFlight.delete(key);job=undefined;}
 const shared=!!job;
 if(!job){
  const controller=new AbortController(),created:Job={promise:buildPreparation(films,seenIds,discovered,options,fingerprint,controller.signal,inherited,!!supplied),controller,subscribers:0,settled:false};job=created;inFlight.set(key,created);
  void created.promise.then(value=>{created.settled=true;if(!controller.signal.aborted){if(completed.size>=24)completed.delete(completed.keys().next().value!);completed.set(key,{at:Date.now(),value});}},()=>{created.settled=true;}).finally(()=>{if(inFlight.get(key)===created)inFlight.delete(key);});
 }
 job.subscribers++;let abort=()=>{};
 try{const value=await Promise.race([job.promise,new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal.addEventListener('abort',abort,{once:true});})]);const result=pack(value);if(shared)result.usage={...emptyUsage(config().curatorModel),cached:true};return result;}
 finally{signal.removeEventListener('abort',abort);job.subscribers--;if(!job.subscribers&&!job.settled)job.controller.abort(new DOMException('Preparation was canceled.','AbortError'));}
}
const zeroTimings=():DiscoveryTimings=>({metadataMs:0,anchorResearchMs:0,draftMs:0,candidateResolutionMs:0,focusedResearchMs:0,prepareMs:0,selectionMs:0,totalMs:0,preparationReused:false});
export function balanceReferences(references:Reference[],films:Film[],limit=12){
 const unique=new Map<string,Reference>();for(const ref of references){const old=unique.get(ref.source.url);unique.set(ref.source.url,old?{...old,anchorIds:[...new Set([...old.anchorIds,...ref.anchorIds])],text:old.text.length>=ref.text.length?old.text:ref.text}:ref);}
 const chosen:Reference[]=[],used=new Set<string>();const add=(ref:Reference)=>{if(chosen.length<limit&&!used.has(ref.source.url)){chosen.push(ref);used.add(ref.source.url);}};
 const values=[...unique.values()];
 for(const film of [...films].sort((a,b)=>a.id.localeCompare(b.id))){const ref=values.find(r=>r.anchorIds.includes(film.id)&&!used.has(r.source.url));if(ref)add(ref);}
 for(const ref of values.filter(r=>r.purpose==='lens'||r.purpose==='candidate'))add(ref);
 for(const ref of values)add(ref);
 return chosen.map(ref=>({...ref,text:ref.text.slice(0,10000)}));
}
async function buildPreparation(films:Film[],seenIds:string[],discovered:DiscoveredFilm[],options:ResearchOptions,fingerprint:string,callerSignal:AbortSignal,prior:Preparation|null=null,allowRetainedCandidates=false):Promise<PreparedWork>{
 const started=Date.now(),controller=new AbortController(),signal=AbortSignal.any([callerSignal,controller.signal,AbortSignal.timeout(60000)]),timings=zeroTimings();
 const anchors=selectedInput(films,options.language),anchorMap=new Map(anchors.map(a=>[a.code,a.id]));
 const eligible=prior&&allowRetainedCandidates?eligiblePreparedCandidates(prior,seenIds,options):[];
 // A changed selected set inherits readings only. Its old candidate arguments
 // must be rebuilt around the new whole path with equal selected-film weights.
 const retained=eligible.length>0&&eligible.length<12?eligible:[],candidateCount=retained.length?12:24;
 const inheritedReferences=prior?.references??[];
 const sourceCovered=new Set(inheritedReferences.flatMap(ref=>ref.text.trim()?ref.anchorIds:[]));
 const inheritedCoverage=(prior?.coveredFilmIds??[]).filter(id=>sourceCovered.has(id)&&films.some(f=>f.id===id));
 const anchorPromise=prepareAnchorReferences(films.filter(f=>!inheritedCoverage.includes(f.id)),{remaining:32,signal},signal).catch(()=>({references:[] as Reference[],usage:emptyUsage(config().searchModel),elapsedMs:0,coveredFilmIds:[] as string[]}));
 try{
  const draftStarted=Date.now();
  const planned=await curatorResponse('draft',curationDraftSchema(anchors.map(a=>a.code),candidateCount),CURATOR_DRAFT_PROMPT,{language:options.language,intent:options.intent,requestedCandidateCount:candidateCount,selected:anchors,selectedFilmReferences:balanceReferences([...inheritedReferences,...peekAnchorReferences(films)],films,6).map(ref=>({title:ref.source.title,discussedFilmIds:ref.anchorIds,excerpt:ref.text.slice(0,4000)})),avoidPreviouslyDisplayed:discovered.slice(-120).map(f=>({title:f.title,year:f.year,director:f.director})),...(retained.length?{retainedLenses:prior!.lenses,retainedCandidates:retained.map(row=>({code:row.code,title:row.film.title,year:row.film.year,director:row.film.director,lens:row.draft.lens,bridge:row.draft.bridge}))}:{})},signal,retained.length?3000:4400,35000);
  timings.draftMs=Date.now()-draftStarted;
  const parsed=DraftSchema.safeParse(planned.output);if(!parsed.success)throw new AppError('INVALID_RESEARCH','The curator’s film plan could not be read.');
  const draft=parsed.data,lenses=new Map(draft.lenses.map(l=>[l.id,l]));
  // Keep the meaning attached to an existing candidate's lens ID stable even if
  // the top-up model unnecessarily rewrites a label or question.
  if(retained.length)for(const lens of prior!.lenses)lenses.set(lens.id,lens);
  const identities=new Set(retained.map(row=>normalizedText(row.film.title)+'|'+row.film.year));
  const candidates=draft.candidates.slice(0,candidateCount).flatMap(value=>{const row=CuratorialCandidate.safeParse(value);if(!row.success)return [];const c=row.data,key=normalizedText(c.title)+'|'+c.year;if(identities.has(key)||!lenses.has(c.lens)||!c.anchors.some(a=>anchorMap.has(a)))return [];identities.add(key);return [c];});
  if(!candidates.length&&!retained.length)throw new AppError('INVALID_RESEARCH','No complete film candidates were generated.');
  const offset=retained.reduce((max,row)=>Math.max(max,/^c\d+$/.test(row.code)?Number(row.code.slice(1))+1:0),0);
  const provisional:Film[]=candidates.map((c,i)=>({id:`candidate:${offset+i}`,title:c.title,year:c.year,director:c.director,poster:''}));
  const focused:CuratorialQuery[]=draft.queries.filter(q=>q.purpose!=='anchor').slice(0,1).map(q=>({query:q.query,purpose:q.purpose,filmIds:[...new Set([...q.anchors.map(code=>anchorMap.get(code)).filter((id):id is string=>!!id),...provisional.filter(f=>filmMentioned(q.query,f)).map(f=>f.id)])]}));
  const resolutionStarted=Date.now(),focusStarted=Date.now();
  const [resolved,focus,anchorResult]=await Promise.all([
   resolveCandidates(candidates,{remaining:110,signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])}).then(result=>{timings.candidateResolutionMs=Date.now()-resolutionStarted;return result;}),
   (focused.length?findCuratorialReferences([...films,...provisional],focused,{remaining:12,signal},AbortSignal.any([signal,AbortSignal.timeout(10000)])):Promise.resolve({references:[],usage:emptyUsage(config().searchModel)})).catch(()=>({references:[] as Reference[],usage:emptyUsage(config().searchModel)})).then(result=>{timings.focusedResearchMs=Date.now()-focusStarted;return result;}),
   anchorPromise,
  ]);
  signal.throwIfAborted();timings.anchorResearchMs=anchorResult.elapsedMs;
  const canonical=new Map<string,string>();resolved.forEach((film,i)=>{if(film)canonical.set(`candidate:${offset+i}`,film.id);});
  const forbidden=new Set(films.map(f=>f.id));if(options.intent==='regenerate')for(const id of [...seenIds,...options.previousIds])forbidden.add(id);
  const used=new Set(retained.map(row=>row.film.id));const fresh=resolved.flatMap((film,i)=>{if(!film||forbidden.has(film.id)||used.has(film.id))return [];used.add(film.id);return [{code:`c${offset+i}`,draft:candidates[i],film}];});
  const verified=[...retained,...fresh].slice(0,32);
  if(!verified.length)throw new AppError(options.intent==='regenerate'?'NO_NEW_FILMS':'FILM_RESOLUTION_FAILED','No new verified films were found. Your current path is unchanged.');
  const references=balanceReferences([...inheritedReferences,...anchorResult.references,...focus.references].map(ref=>({...ref,anchorIds:ref.anchorIds.map(id=>canonical.get(id)||id)})),films);
  const coveredFilmIds=[...new Set([...inheritedCoverage,...anchorResult.coveredFilmIds])].sort();
  const queries=[...new Map([...(retained.length?prior!.queries:[]),...draft.queries].map(query=>[normalizedText(query.query),query])).values()].slice(0,6);
  const preparation:Preparation={version:1,issued:Date.now(),fingerprint,language:options.language,selected:films,lenses:[...lenses.values()].slice(0,3),queries,candidates:verified,references,coveredFilmIds};
  timings.prepareMs=Date.now()-started;timings.totalMs=timings.prepareMs;
  const usage=sumUsage(sumUsage(planned.usage,anchorResult.usage),focus.usage);
  console.info('STRADA preparation audit',{timings,selected:films.length,covered:coveredFilmIds.length,retained:retained.length,requested:candidateCount,added:fresh.length,candidates:verified.length,references:references.length,usage});
  return {preparation,usage,timings};
 }finally{controller.abort();}
}
