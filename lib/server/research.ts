import type {DiscoveredFilm} from '../discovery-context';
import {RECOMMENDATION_COUNT,discoveryCacheKey,selectFreshRecommendations,validateFreshRecommendations} from '../recommendation-policy';
import {weights,titleOf,type Film,type Batch,type Source,type Recommendation,type ResearchOptions} from '../domain';
import {CuratorialCandidate,DraftSchema,CurationSchema,CuratedFilm,EvidenceNote,curationDraftSchema,curationSelectionSchema,CURATOR_DRAFT_PROMPT,CURATOR_SELECT_PROMPT,type Candidate} from '../curation-contract';
import {config,AppError} from './config';
import {getFilms,resolveCandidates} from './metadata';
import type {Budget} from './tmdb';
import {normalizedText,filmMentioned} from './grounding';
import {findCuratorialReferences,emptyUsage,sumUsage,type Reference,type ResearchUsage,type CuratorialQuery} from './source-search';
import {curatorResponse} from './curator-model';
import {issueDetailToken} from './curation-detail';
import {localizeTitles} from '../i18n';

export const RESEARCH_PROMPT=CURATOR_DRAFT_PROMPT;
export type ResearchResult={batch:Batch,seeds:Film[],trail:Film[],usage:ResearchUsage};
const completed=new Map<string,{at:number,value:ResearchResult,requestedIds:string[]}>();
type ResearchJob={promise:Promise<ResearchResult>,controller:AbortController,subscribers:number,settled:boolean,requestedIds:string[]};
const inFlight=new Map<string,ResearchJob>();

export async function research(seedIds:string[],trailIds:string[],signal:AbortSignal,seenIds:string[]=[],discoveredFilms:DiscoveredFilm[]=[],options:ResearchOptions={intent:trailIds.length?'follow':'initial',previousIds:[],language:'en'}):Promise<ResearchResult>{
 signal.throwIfAborted();
 const conf=config(),allSeen=[...new Set([...seenIds,...discoveredFilms.map(f=>f.id)])];
 const key=discoveryCacheKey(conf.curatorModel+':'+conf.searchModel,seedIds,trailIds,discoveredFilms,options,allSeen),old=completed.get(key);
 const ordered=(result:ResearchResult,requestedIds:string[])=>{const responseFilms=[...result.seeds,...result.trail],films=new Map(requestedIds.map((id,index)=>[id,responseFilms[index]]));return {...result,seeds:seedIds.map(id=>films.get(id)!),trail:trailIds.map(id=>films.get(id)!)};};
 if(old&&Date.now()-old.at<1_800_000)return ordered({...old.value,usage:{...emptyUsage(old.value.usage.model),cached:true}},old.requestedIds);
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
type Verified={code:string,draft:Candidate,film:Film};
async function runResearch(seedIds:string[],trailIds:string[],seenIds:string[],discoveredFilms:DiscoveredFilm[],options:ResearchOptions,requestSignal:AbortSignal):Promise<ResearchResult>{
 const conf=config();if(!conf.openai)throw new AppError('SETUP_REQUIRED','AI discovery is not connected.',503);
 const started=Date.now(),deadline=started+90_000,signal=AbortSignal.any([requestSignal,AbortSignal.timeout(90_000)]);
 const budget:Budget={remaining:160,signal};
 const films=await getFilms([...seedIds,...trailIds],budget);
 signal.throwIfAborted();
 const seeds=films.slice(0,seedIds.length),trail=films.slice(seedIds.length),selectedIds=films.map(f=>f.id);
 if(!films.length)throw new AppError('INVALID_INPUT','Choose starting films first.',400);
 if(new Set(selectedIds).size!==films.length)throw new AppError('DUPLICATE_FILM','Each film can appear only once.',400);
 const anchors=new Map(weights(seeds,trail).sort((a,b)=>a.film.id.localeCompare(b.film.id)).map((item,i)=>[`a${i}`,item]));
 const anchorInput=[...anchors].map(([code,item])=>({code,id:item.film.id,title:item.film.title,titleKo:item.film.titleKo,displayTitle:titleOf(item.film,options.language),year:item.film.year,director:item.film.director,weight:item.weight,overview:(item.film.overviewEn||item.film.synopsisEn||item.film.overviewKo||'').slice(0,1100),country:item.film.country}));
 const forbidden=new Set(selectedIds);if(options.intent==='regenerate')for(const id of [...seenIds,...options.previousIds])forbidden.add(id);
 // All historical IDs remain hard exclusions on regenerate. Displayed titles are not positive taste.
 const avoid=discoveredFilms.slice(-120).map(f=>({title:f.title,year:f.year,director:f.director}));
 const planned=await curatorResponse('draft',curationDraftSchema([...anchors.keys()]),CURATOR_DRAFT_PROMPT,{language:options.language,intent:options.intent,selected:anchorInput,avoidPreviouslyDisplayed:avoid},signal,6500,Math.min(35_000,deadline-Date.now()-35_000));
 let usage=planned.usage;
 const draftResult=DraftSchema.safeParse(planned.output);if(!draftResult.success)throw new AppError('INVALID_RESEARCH','The curator’s film plan could not be read.');
 const draft=draftResult.data,lenses=new Map(draft.lenses.map(l=>[l.id,l]));
 const candidateKeys=new Set<string>();
 const candidates=draft.candidates.map(row=>CuratorialCandidate.safeParse(row)).filter(row=>row.success).map(row=>row.data).filter(row=>{const key=normalizedText(row.title)+'|'+row.year;if(candidateKeys.has(key)||!lenses.has(row.lens)||!row.anchors.some(a=>anchors.has(a)))return false;candidateKeys.add(key);return true;});
 if(!candidates.length)throw new AppError('INVALID_RESEARCH','No complete film candidates were generated.');
 const provisional:Film[]=candidates.map((candidate,i)=>({id:`candidate:${i}`,title:candidate.title,year:candidate.year,director:candidate.director,poster:''}));
 const queries:CuratorialQuery[]=draft.queries.map(query=>({query:query.query,purpose:query.purpose,filmIds:[...new Set([...query.anchors.map(code=>anchors.get(code)?.film.id).filter((id):id is string=>!!id),...provisional.filter(f=>filmMentioned(query.query,f)).map(f=>f.id)])]}));
 if(!queries.length){for(const film of films.slice(0,2))queries.push({query:`${film.title} ${film.year} ${film.director} criticism cinematic form`,purpose:'anchor',filmIds:[film.id]});queries.push({query:draft.lenses[0].question+' film criticism',purpose:'lens',filmIds:[]});}
 const sourceMs=Math.min(18_000,Math.max(1,deadline-Date.now()-30_000));
 const sourceSignal=AbortSignal.any([signal,AbortSignal.timeout(sourceMs)]);
 const metadataSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.min(20_000,Math.max(1,deadline-Date.now()-28_000)))]);
 const [resolved,live]=await Promise.all([
  resolveCandidates(candidates,{remaining:110,signal:metadataSignal}),
  findCuratorialReferences([...films,...provisional],queries,{remaining:32,signal:sourceSignal},sourceSignal).catch(error=>{console.warn('STRADA evidence fallback',{error:error instanceof Error?error.name:'unknown'});return {references:[] as Reference[],usage:emptyUsage(conf.searchModel)};}),
 ]);
 signal.throwIfAborted();usage=sumUsage(usage,live.usage);
 const identityMap=new Map<string,string>();resolved.forEach((film,i)=>{if(film)identityMap.set(`candidate:${i}`,film.id);});
 const duplicate=new Set<string>();
 const verified:Verified[]=resolved.flatMap((film,i)=>{if(!film||forbidden.has(film.id)||duplicate.has(film.id))return [];duplicate.add(film.id);return [{code:`c${i}`,draft:candidates[i],film}];});
 if(!verified.length)throw new AppError(options.intent==='regenerate'?'NO_NEW_FILMS':'FILM_RESOLUTION_FAILED','No new verified films were found. Your current path is unchanged.');
 const references=new Map(live.references.slice(0,8).map((reference,i)=>[`s${i}`,{...reference,anchorIds:reference.anchorIds.map(id=>identityMap.get(id)||id)}]));
 const referenceInput=[...references].map(([code,reference])=>({code,title:reference.source.title,kind:reference.source.type,discussedFilmIds:reference.anchorIds,excerpt:reference.text}));
 const byCode=new Map(verified.map(row=>[row.code,row]));
 let ranking=verified.map(row=>row.code),rejected=new Set<string>(),curated=new Map<string,ReturnType<typeof CuratedFilm.parse>>(),curationFallback=false;
 try{
  const selected=await curatorResponse('curate',curationSelectionSchema([...byCode.keys()],[...anchors.keys()],[...references.keys()]),CURATOR_SELECT_PROMPT,{
   language:options.language,intent:options.intent,selected:anchorInput,lenses:draft.lenses,references:referenceInput,
   freshness:{previousIds:options.previousIds,maximumPreviousOverlap:options.intent==='follow'||options.intent==='manual'?5:0},
   verifiedCandidates:verified.map(row=>({code:row.code,id:row.film.id,...row.draft,title:row.film.title,titleKo:row.film.titleKo,displayTitle:titleOf(row.film,options.language),year:row.film.year,director:row.film.director,overview:(row.film.overviewEn||row.film.synopsisEn||'').slice(0,700),previouslyShown:seenIds.includes(row.film.id),inPreviousList:options.previousIds.includes(row.film.id)})),
  },signal,5500,Math.min(27_000,Math.max(1,deadline-Date.now()-1500)));
  usage=sumUsage(usage,selected.usage);const output=CurationSchema.safeParse(selected.output);if(!output.success)throw new AppError('INVALID_RESEARCH','The final curation was incomplete.');
  ranking=[...new Set([...output.data.ranking,...ranking])].filter(code=>byCode.has(code));rejected=new Set(output.data.rejected.filter(code=>byCode.has(code)));
  curated=new Map(output.data.recommendations.flatMap(value=>{const row=CuratedFilm.safeParse(value);return row.success&&byCode.has(row.data.candidate)?[[row.data.candidate,row.data] as const]:[];}));
 }catch(error){if(requestSignal.aborted)throw requestSignal.reason;curationFallback=true;console.warn('STRADA final curation fallback',{error:error instanceof AppError?error.code:error instanceof Error?error.name:'unknown'});}
 const sources=new Map<string,Source>();
 const recommendations:Recommendation[]=ranking.filter(code=>!rejected.has(code)).map(code=>{
  const verifiedFilm=byCode.get(code)!,row=curated.get(code),plan=verifiedFilm.draft;
  const anchorCodes=[...new Set((row?.anchors??plan.anchors).filter(a=>anchors.has(a)))];if(!anchorCodes.length)anchorCodes.push(plan.anchors.find(a=>anchors.has(a))!);
  const sourceIds:string[]=[];
  for(const value of row?.evidence??[]){const parsed=EvidenceNote.safeParse(value);if(!parsed.success)continue;const note=parsed.data,reference=references.get(note.ref);if(!reference||!supportsPassage(reference,note.passage)||!note.point)continue;
   const id=`ref:${note.ref}:${code}`;if(sourceIds.includes(id))continue;sources.set(id,{...reference.source,id,scope:'interpretive_context',excerpt:note.passage,summary:note.point,...options.language==='ko'?{summaryKo:note.point}:{}});sourceIds.push(id);
  }
  const localize=(text:string)=>localizeTitles(text,[...films,...verified.map(v=>v.film)],options.language);
  const why=localize(row?.why||[plan.bridge,plan.contrast].filter(Boolean).join(' '));
  return {film:verifiedFilm.film,sourceIds,contextScope:sourceIds.length?undefined:'discovery',curation:{lens:localize(row?.lens||lenses.get(plan.lens)!.label),bridge:localize(row?.bridge||plan.bridge),contrast:localize(row?.contrast||plan.contrast)},connections:anchorCodes.map((anchorCode,index)=>{const anchor=anchors.get(anchorCode)!.film;const ids=index===0?sourceIds:[];return {anchorId:anchor.id,anchorTitle:anchor.title,relation:ids.length?'grounded_interpretation' as const:'ai_inference' as const,why,...options.language==='ko'?{whyKo:why}:{},sourceIds:ids};})};
 });
 const fresh=selectFreshRecommendations(recommendations,selectedIds,seenIds,options.previousIds,options.intent,RECOMMENDATION_COUNT);
 const validation=validateFreshRecommendations(fresh,selectedIds,seenIds,options.previousIds,options.intent,RECOMMENDATION_COUNT,false);
 if(!validation.valid)throw new AppError('NO_NEW_FILMS','More new films could not be found. Your path is unchanged.');
 const used=new Set(fresh.flatMap(rec=>rec.sourceIds)),usedSources=[...sources.values()].filter(source=>used.has(source.id));
 for(const rec of fresh)rec.detailToken=issueDetailToken(rec,films,usedSources);
 requestSignal.throwIfAborted();
 console.info('STRADA curation audit',{elapsedMs:Date.now()-started,intent:options.intent,selectedCount:films.length,proposed:candidates.length,verified:verified.length,references:references.size,count:fresh.length,sourced:fresh.filter(r=>r.sourceIds.length).length,fresh:validation.freshCount,overlap:validation.overlapCount,curationFallback,usage});
 return {batch:{recommendations:fresh,sources:usedSources,mode:'live',...(fresh.length<RECOMMENDATION_COUNT?{notice:'partial' as const}:{})},seeds,trail,usage};
}
