import type {DiscoveredFilm} from '../discovery-context';
import {RECOMMENDATION_COUNT,discoveryModelContext,discoveryCacheKey,coversDiscoveryContext} from '../recommendation-policy';
import {claimPublicQuota} from './claim-quota';
import {config,AppError} from './config';
import {weights,type Film,type Batch,type Source,type Recommendation} from '../domain';
import {getFilms,resolveCandidates} from './metadata';
import type {Budget} from './tmdb';
import {normalizedText} from './grounding';
import {sourceLibrary} from '../catalogue';
import {rankRecommendations} from '../ranking';
import {enrichPosterBatch} from './wikimedia';
import {PlanCandidate,PlanEnvelope,ExplanationOutput,ExplanationEnvelope,SourceNote,parseResearchOutput,recommendationPlanSchema,recommendationExplanationSchema,RESEARCH_PROMPT,EXPLANATION_PROMPT} from '../research-contract';
import {findFilmReferences,emptyUsage,responseUsage,sumUsage,type Reference,type ResearchUsage} from './source-search';
export {RESEARCH_PROMPT};
export type ResearchResult={batch:Batch,seeds:Film[],trail:Film[],usage:ResearchUsage};
const completed=new Map<string,{at:number,value:ResearchResult}>();
type ResearchJob={promise:Promise<ResearchResult>,controller:AbortController,subscribers:number,settled:boolean};
const inFlight=new Map<string,ResearchJob>();
export async function research(seedIds:string[],trailIds:string[],signal:AbortSignal,seenIds:string[]=[],callerIp='local',discoveredFilms:DiscoveredFilm[]=[]):Promise<ResearchResult>{
 signal.throwIfAborted();
 const key=discoveryCacheKey(config().model,seedIds,trailIds,discoveredFilms),old=completed.get(key);
 if(old&&Date.now()-old.at<1_800_000)return {...old.value,usage:{...emptyUsage(old.value.usage.model),cached:true},batch:{...old.value.batch,recommendations:rankRecommendations(old.value.batch.recommendations,old.value.seeds,old.value.trail,seenIds,RECOMMENDATION_COUNT)}};
 let job=inFlight.get(key);if(job?.controller.signal.aborted){inFlight.delete(key);job=undefined;}
 if(!job){
  const controller=new AbortController();
  const created:ResearchJob={promise:runResearch(seedIds,trailIds,seenIds,callerIp,discoveredFilms,controller.signal),controller,subscribers:0,settled:false};
  job=created;inFlight.set(key,created);
  void created.promise.then(value=>{created.settled=true;if(!controller.signal.aborted){if(completed.size>=40)completed.delete(completed.keys().next().value!);completed.set(key,{at:Date.now(),value});}},()=>{created.settled=true;}).finally(()=>{if(inFlight.get(key)===created)inFlight.delete(key);});
 }
 job.subscribers++;
 try{return await waitForRequest(job.promise,signal);}
 finally{job.subscribers--;if(!job.subscribers&&!job.settled)job.controller.abort(new DOMException('The discovery request was canceled.','AbortError'));}
}
async function waitForRequest<T>(job:Promise<T>,signal:AbortSignal){
 if(signal.aborted)throw signal.reason;let abort=()=>{};
 try{return await Promise.race([job,new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason??new DOMException('Aborted','AbortError'));signal.addEventListener('abort',abort,{once:true});})]);}
 finally{signal.removeEventListener('abort',abort);}
}
function supportsPassage(ref:Reference,passage:string){const needle=normalizedText(passage);return needle.length>=25&&normalizedText(ref.text).includes(needle);}
async function phase<T>(name:string,action:()=>Promise<T>){
 const started=Date.now();
 try{const value=await action();console.info('STRADA research phase',{phase:name,elapsedMs:Date.now()-started,status:'ok'});return value;}
 catch(error){console.warn('STRADA research phase',{phase:name,elapsedMs:Date.now()-started,status:'failed',error:error instanceof AppError?error.code:error instanceof Error?error.name:'unknown'});throw error;}
}
async function modelResponse(key:string,schema:unknown,name:string,prompt:string,input:unknown,signal:AbortSignal,maxTokens:number){
 const model='gpt-4o-mini',stage=name.startsWith('strada_plan_')?'plan':'explanation';
 const stageSignal=AbortSignal.any([signal,AbortSignal.timeout(stage==='plan'?60000:65000)]);
 let response:Response;
 try{response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:stageSignal,body:JSON.stringify({model,store:false,max_output_tokens:maxTokens,text:{format:{type:'json_schema',name,strict:true,schema}},input:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}]})});}
 catch(error){if(signal.aborted)throw signal.reason;if(stageSignal.aborted)throw new AppError('TIMEOUT','AI discovery took too long. Please try again.',504);throw new AppError('RESEARCH_ERROR','The AI connection was interrupted. Please try again.');}
 if(!response.ok)throw new AppError(response.status===429?'RATE_LIMIT':response.status===401?'SETUP_REQUIRED':'RESEARCH_ERROR','AI discovery could not finish. Your path is unchanged.',response.status===429?429:502);
 let data:any;try{data=await response.json();}catch{if(signal.aborted)throw signal.reason;if(stageSignal.aborted)throw new AppError('TIMEOUT','AI discovery took too long. Please try again.',504);throw new AppError('INVALID_RESEARCH','The AI response could not be read.');}
 if(data.status!=='completed'&&data.status!=='incomplete')throw new AppError('INCOMPLETE','The recommendation response was incomplete.');
 const raw=(Array.isArray(data.output)?data.output:[]).filter((x:any)=>x?.type==='message').flatMap((x:any)=>Array.isArray(x.content)?x.content:[]).filter((x:any)=>x?.type==='output_text'&&typeof x.text==='string').map((x:any)=>x.text).join('');
 const output=parseResearchOutput(raw,stage);if(output===null)throw new AppError('INVALID_RESEARCH','The recommendation response could not be read.');
 if(data.status==='incomplete')console.info('STRADA partial model response',{phase:stage,reason:data.incomplete_details?.reason??'unknown'});
 return {output,usage:responseUsage(data,model)};
}
async function runResearch(seedIds:string[],trailIds:string[],seenIds:string[],callerIp:string,discoveredFilms:DiscoveredFilm[],requestSignal:AbortSignal):Promise<ResearchResult>{
 const conf=config();if(!conf.openai)throw new AppError('SETUP_REQUIRED','AI discovery is not connected.',503);
 const signal=AbortSignal.any([requestSignal,AbortSignal.timeout(270000)]),budget:Budget={remaining:120,signal};
 const films=await phase('selected-metadata',()=>getFilms([...seedIds,...trailIds],budget)),seeds=films.slice(0,seedIds.length),trail=films.slice(seedIds.length);
 if(new Set(films.map(f=>f.id)).size!==films.length)throw new AppError('DUPLICATE_FILM','Each film can appear only once.',400);
 const active=weights(seeds,trail).sort((a,b)=>a.film.id.localeCompare(b.film.id));
 const anchors=new Map(active.map((x,i)=>[`a${i}`,x]));
 const discoveryContext=discoveryModelContext(films,discoveredFilms);
 // Previously reviewed source summaries are context; stored recommendation prose is never evidence.
 const known:Reference[]=sourceLibrary.filter(s=>s.type!=='catalogue'&&active.some(x=>x.film.sourceIds?.includes(s.id))).map(source=>({source,text:source.summary,anchorIds:active.filter(x=>x.film.sourceIds?.includes(source.id)).map(x=>x.film.id)}));
 await claimPublicQuota(callerIp);
 const sourceSignal=AbortSignal.any([signal,AbortSignal.timeout(35000)]);
 const live=await phase('sources',()=>findFilmReferences(active.map(x=>x.film).filter(f=>!known.some(r=>r.anchorIds.includes(f.id))),budget,sourceSignal));
 signal.throwIfAborted();
 const references=new Map([...known,...live.references].slice(0,16).map((ref,i)=>[`s${i}`,ref]));
 const anchorInput=[...anchors].map(([code,x])=>({code,title:x.film.title,year:x.film.year,director:x.film.director,weight:x.weight}));
 const referenceInput=[...references].map(([code,ref])=>({code,title:ref.source.title,kind:ref.source.type,anchorCodes:[...anchors].filter(([,x])=>ref.anchorIds.includes(x.film.id)).map(([id])=>id),excerpt:ref.text.slice(0,5000)}));
 const excluded=new Set(films.map(f=>f.id)),generated:Recommendation[]=[],usedSources=new Map<string,Source>();
 const plansByFilm=new Map<string,{rationale:string,discoveryBasis:string[]}>();
 const attempted=new Set<string>(),rejected:string[]=[];let usage=live.usage,planCount=0;
 // Verify short proposals before spending tokens on bilingual prose. Repair at most once if necessary.
 for(let pass=0;pass<2&&generated.length<RECOMMENDATION_COUNT;pass++){
  signal.throwIfAborted();
  const planned=await phase(`plan-${pass+1}`,()=>modelResponse(conf.openai!,recommendationPlanSchema([...anchors.keys()],[...references.keys()],discoveryContext.map(f=>f.code)),'strada_plan_v1',RESEARCH_PROMPT,{anchors:anchorInput,discoveryContext,references:referenceInput,exclude:[...films,...generated.map(r=>r.film)].map(f=>({title:f.title,year:f.year})),previouslyUnresolved:rejected,needed:RECOMMENDATION_COUNT-generated.length},signal,6500));
  usage=sumUsage(usage,planned.usage);planCount++;
  const parsedPlan=PlanEnvelope.safeParse(planned.output);if(!parsedPlan.success)throw new AppError('INVALID_RESEARCH','The generated film plan could not be read.');
  const candidates=parsedPlan.data.candidates.map(c=>PlanCandidate.safeParse(c)).filter(c=>c.success).map(c=>c.data).filter(c=>{const key=normalizedText(c.title)+'|'+c.year;if(attempted.has(key))return false;attempted.add(key);return true;});
  for(let start=0;start<candidates.length&&generated.length<RECOMMENDATION_COUNT;start+=4){
   signal.throwIfAborted();
   const chunk=candidates.slice(start,start+4),resolved=await phase('candidate-metadata',()=>resolveCandidates(chunk,budget));
   chunk.forEach((candidate,i)=>{
    const film=resolved[i];if(!film){rejected.push(`${candidate.title} (${candidate.year}, ${candidate.director})`);return;}if(excluded.has(film.id))return;
    const valid=candidate.connections.filter((c,j,all)=>anchors.has(c.anchor)&&all.findIndex(x=>x.anchor===c.anchor)===j);if(!valid.length)return;
    const connections=valid.map(edge=>{
     const anchor=anchors.get(edge.anchor)!;const ids=[...new Set(edge.evidence.filter(e=>references.get(e.ref)?.anchorIds.includes(anchor.film.id)).map(e=>e.ref))];
     for(const id of ids){const ref=references.get(id)!;usedSources.set(id,{...ref.source,id:`ref:${id}`,scope:'interpretive_context'});}
     return {anchorId:anchor.film.id,anchorTitle:anchor.film.title,relation:ids.length?'grounded_interpretation' as const:'ai_inference' as const,why:edge.reason||candidate.rationale,whyKo:edge.reasonKo||undefined,sourceIds:ids.map(id=>`ref:${id}`)};
    }).sort((a,b)=>Number(b.sourceIds.length>0)-Number(a.sourceIds.length>0));
    const sourceIds=[...new Set(connections.flatMap(c=>c.sourceIds))];if(!sourceIds.length&&!coversDiscoveryContext(candidate.discoveryBasis,discoveryContext))return;
    excluded.add(film.id);generated.push({film,connections,sourceIds,...!sourceIds.length?{contextScope:'discovery' as const}:{}});plansByFilm.set(film.id,{rationale:candidate.rationale,discoveryBasis:candidate.discoveryBasis});
   });
  }
 }
 if(generated.length<RECOMMENDATION_COUNT)throw new AppError('FILM_RESOLUTION_FAILED','Twelve distinct film suggestions could not be matched to the movie database. Please retry.');
 const ranked=rankRecommendations(generated,seeds,trail,seenIds,RECOMMENDATION_COUNT),used=new Set(ranked.flatMap(r=>r.sourceIds));
 let explanationRows:Record<string,unknown>={},sourceNotes:unknown[]=[];
 try{
 const explained=await phase('explanations',()=>modelResponse(conf.openai!,recommendationExplanationSchema(ranked.map((_,i)=>`r${i}`),[...used].map(id=>id.slice(4))),'strada_explanations_v1',EXPLANATION_PROMPT,{
  anchors:anchorInput,discoveryContext,references:referenceInput.filter(r=>used.has(`ref:${r.code}`)),
  verifiedFilms:ranked.map((r,i)=>({code:`r${i}`,film:{id:r.film.id,title:r.film.title,titleKo:r.film.titleKo,year:r.film.year,director:r.film.director},scope:r.contextScope==='discovery'?'discovery':'sourced',...plansByFilm.get(r.film.id),connections:r.connections.map(c=>({anchor:[...anchors].find(([,a])=>a.film.id===c.anchorId)?.[0],reason:c.why,sourceCodes:c.sourceIds.map(id=>id.slice(4))}))}))
 },signal,10500));
 usage=sumUsage(usage,explained.usage);const parsed=ExplanationEnvelope.safeParse(explained.output);
 if(parsed.success){explanationRows=parsed.data.explanations;sourceNotes=parsed.data.sourceNotes;}
 }catch(error){if(requestSignal.aborted)throw requestSignal.reason;console.warn('STRADA explanation fallback',{error:error instanceof AppError?error.code:error instanceof Error?error.name:'unknown'});}
 let explanationFallbacks=0;
 for(const [i,rec] of ranked.entries()){
  const explanation=ExplanationOutput.safeParse(explanationRows[`r${i}`]);
  if(explanation.success){const why=explanation.data.paragraphs.map(p=>p.en).filter(Boolean).join('\n\n'),whyKo=explanation.data.paragraphs.map(p=>p.ko).filter(Boolean).join('\n\n');rec.connections[0]={...rec.connections[0],why:why||whyKo,whyKo:whyKo||undefined};}
  else{explanationFallbacks++;const why=plansByFilm.get(rec.film.id)?.rationale||rec.connections[0].why;rec.connections[0]={...rec.connections[0],why,whyKo:rec.contextScope==='discovery'?undefined:rec.connections[0].whyKo};}
 }
 for(const input of sourceNotes){const note=SourceNote.safeParse(input);if(!note.success)continue;const ref=references.get(note.data.ref),source=usedSources.get(note.data.ref);if(ref&&source&&supportsPassage(ref,note.data.passage))usedSources.set(note.data.ref,{...source,summary:note.data.summary||source.summary,summaryKo:note.data.summaryKo||source.summaryKo});}
 requestSignal.throwIfAborted();
 if(!signal.aborted)try{const posters=await enrichPosterBatch(ranked.map(r=>r.film),budget);for(const rec of ranked)rec.film=posters.find(f=>f.id===rec.film.id)??rec.film;}catch{}
 const sources=[...usedSources.values()].filter(s=>used.has(s.id));
 console.info('STRADA recommendation audit',JSON.stringify({anchors:films.map(f=>f.title),references:references.size,discoveryContextCount:discoveryContext.length,weights:active.map(x=>({id:x.film.id,weight:x.weight})),planCount,rejected,count:ranked.length,sourced:ranked.filter(r=>r.sourceIds.length).length,globalAI:ranked.filter(r=>r.contextScope==='discovery').length,explanationFallbacks,usage}));
 return {batch:{recommendations:ranked,sources,mode:'live'},seeds,trail,usage};
}
