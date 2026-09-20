import {z} from 'zod';
import {type Batch,type Connection,type Film,type Language,type Recommendation,type Source} from '../domain';
import {RecommendationInput} from './recommendation-input';
import {AppError} from './config';
import {getFilms} from './metadata';
import {issueDetailToken} from './curation-detail';
import {runCuratorV1} from './curator-v1/engine';
import type {CuratorDecision,ContextBundle,ContextPassage,ResolvedCuratorRecommendation} from './curator-v1/contract';
import type {KnowledgeRepository} from './knowledge/repository';
import {knowledgeRepository} from './knowledge/corpus';

export type CuratorProductionInput=z.infer<typeof RecommendationInput>;
type CuratorRun=Awaited<ReturnType<typeof runCuratorV1>>;

export type CuratorProductionDependencies={
 getFilms:typeof getFilms;
 repository:KnowledgeRepository;
 runCurator:typeof runCuratorV1;
 detailToken:typeof issueDetailToken;
};

export type CuratorProductionResult={
 batch:Batch;
 seeds:Film[];
 trail:Film[];
 usage:CuratorRun['usage'];
 timings:{
  metadataMs:number;
  contextMs:number;
  modelMs:number;
  repairMs:number;
  candidateResolutionMs:number;
  totalMs:number;
  preparationReused:false;
 };
 model:string;
 contextFingerprint:string;
 contextCoverage:Record<string,number>;
 diagnostics:{engine:string;model:string;corpusVersion:string;documents:number;observations:number;retrievedDocuments:number;retrievedPassages:number;usedDocuments:number;coveredFilmIds:string[];repairAttempted:boolean};
};

export const PRODUCTION_CURATOR_SETTINGS={model:'gpt-5.6-terra',reasoning:'none' as const,timeoutMs:15_750,maxOutputTokens:2_000,promptVersion:'v2' as const,
 repair:{model:'gpt-5.4',timeoutMs:3_750,maxOutputTokens:1_100}};

const defaultDependencies=():CuratorProductionDependencies=>({
 getFilms,
 repository:knowledgeRepository(),
 runCurator:runCuratorV1,
 detailToken:issueDetailToken,
});

/** Displayed history is exclusion data, never an implicit preference signal. */
export function curatorProductionExclusions(input:CuratorProductionInput,selectedIds:string[]){
 const excluded=new Set(selectedIds);
 if(input.intent==='follow'||input.intent==='manual')for(const id of input.previousIds)excluded.add(id);
 if(input.intent==='regenerate')for(const id of [...input.seenIds,...input.previousIds,...input.discoveredFilms.map(film=>film.id)])excluded.add(id);
 return [...excluded].sort();
}

function httpsUrl(raw:string){
 try{const url=new URL(raw);if(url.protocol==='http:')url.protocol='https:';return url.protocol==='https:'?url.href:null;}catch{return null;}
}

function sourceId(passage:ContextPassage){return `context:${passage.id}`;}

function passageSource(passage:ContextPassage,builtAt:string):Source|null{
 const url=httpsUrl(passage.url);if(!url)return null;
 const exact=passage.contentKind==='exact_passage'&&passage.rights!=='link_and_metadata_only';
 return {
  id:sourceId(passage),title:passage.title,publisher:passage.publisher,author:passage.author,date:passage.publishedAt??null,url,
  type:passage.type==='programme'?'festival':passage.type,
  scope:passage.type==='programme'||passage.type==='festival'?'programme_context':'interpretive_context',
  summary:passage.observationEn??(exact?'A located passage used as limited source context for this route.':passage.excerpt),
  summaryKo:passage.observationKo??(exact?'이 경로의 자료 맥락으로 사용한, 위치가 확인된 원문입니다.':passage.excerpt),
  ...(exact?{excerpt:passage.excerpt}:{}),
  accessLevel:passage.accessLevel??(passage.rights==='link_and_metadata_only'?'link_and_metadata_only':passage.type==='academic'?'abstract':'full_text'),
  verifiedOn:(passage.checkedAt??builtAt).slice(0,10),locator:passage.locator,boundary:passage.boundary,documentId:passage.documentId,documentVersion:passage.versionId,reviewStatus:passage.reviewState,
 };
}

function orderedAnchors(proposal:ResolvedCuratorRecommendation,selected:Film[],passages:Map<string,ContextPassage>){
 const mentioned=new Set(proposal.evidenceIds.flatMap(id=>passages.get(id)?.filmIds??[]));
 const allowed=new Set(proposal.anchorIds);
 return selected.filter(film=>allowed.has(film.id)).sort((a,b)=>Number(!mentioned.has(a.id))-Number(!mentioned.has(b.id))||a.id.localeCompare(b.id));
}

function recommendationFromDecision(proposal:ResolvedCuratorRecommendation,decision:CuratorDecision,selected:Film[],context:ContextBundle,language:Language,availableSources:Map<string,Source>):Recommendation{
 const passageMap=new Map(context.passages.map(passage=>[passage.id,passage]));
 const evidence=proposal.evidenceIds.flatMap(id=>{const passage=passageMap.get(id);return passage?[sourceId(passage)]:[];}).filter(id=>availableSources.has(id));
 const anchors=orderedAnchors(proposal,selected,passageMap);
 const sourced=evidence.length>0&&proposal.attribution!=='model_proposal';
 const primaryRelation:Connection['relation']=sourced?(proposal.attribution==='source_explicit'?'direct_connection':'grounded_interpretation'):'ai_inference';
 const connections:Connection[]=anchors.map((anchor,index)=>({
  anchorId:anchor.id,anchorTitle:anchor.title,relation:index===0?primaryRelation:'ai_inference',why:proposal.connection,
  ...(language==='ko'?{whyKo:proposal.connection}:{}),sourceIds:index===0&&sourced?evidence:[],
 }));
 if(!connections.length)throw new AppError('INVALID_RESEARCH','The curator returned a film without a selected-film connection.');
 return {
  film:proposal.film,connections,sourceIds:sourced?evidence:[],...(sourced?{}:{contextScope:'discovery' as const}),
  curation:{lens:decision.lens,bridge:proposal.connection,contrast:''},
 };
}

export function curatorDecisionBatch(decision:CuratorDecision,selected:Film[],context:ContextBundle,language:Language,detailToken:typeof issueDetailToken=issueDetailToken):Batch{
 const usedEvidence=new Set(decision.recommendations.flatMap(recommendation=>recommendation.evidenceIds));
 const sources=new Map<string,Source>();
 for(const passage of context.passages)if(usedEvidence.has(passage.id)){const source=passageSource(passage,context.builtAt);if(source)sources.set(source.id,source);}
 const recommendations=decision.recommendations.map(proposal=>recommendationFromDecision(proposal,decision,selected,context,language,sources));
 const sourceRows=[...sources.values()].filter(source=>recommendations.some(rec=>rec.sourceIds.includes(source.id)));
 for(const rec of recommendations)rec.detailToken=detailToken(rec,selected,sourceRows);
 return {mode:'live',recommendations,sources:sourceRows};
}

/** One bounded repository read and one curator call form the complete list path. */
export async function runCuratorProduction(input:CuratorProductionInput,requestSignal:AbortSignal,dependencies:Partial<CuratorProductionDependencies>={}):Promise<CuratorProductionResult>{
 const deps={...defaultDependencies(),...dependencies},started=Date.now();
 const signal=AbortSignal.any([requestSignal,AbortSignal.timeout(20_000)]),selectedIds=[...input.seeds,...input.trail];
 const metadataStarted=Date.now(),selected=await deps.getFilms(selectedIds,{remaining:160,signal}),metadataMs=Date.now()-metadataStarted;
 if(selected.length!==selectedIds.length||selected.some(film=>!film))throw new AppError('INVALID_FILM','One of the selected films could not be identified.',400);
 if(new Set(selected.map(film=>film.id)).size!==selected.length)throw new AppError('DUPLICATE_FILM','Choose distinct films for this path.',400);
 const seeds=selected.slice(0,input.seeds.length),trail=selected.slice(input.seeds.length);
 // Stable identity order prevents trail recency from becoming an implicit weight.
 const curatorSelected=[...selected].sort((a,b)=>a.id.localeCompare(b.id));
 const excludedIds=curatorProductionExclusions(input,curatorSelected.map(film=>film.id)),excludedSet=new Set(excludedIds);
 const forbiddenFilms=input.discoveredFilms.filter(film=>excludedSet.has(film.id));
 const contextStarted=Date.now(),context=await deps.repository.buildContext(curatorSelected,input.language),contextMs=Date.now()-contextStarted;
 const fixedRepository:KnowledgeRepository={fingerprint:()=>deps.repository.fingerprint(),buildContext:async()=>context};
 const result=await deps.runCurator({
  selected:curatorSelected,excludedIds,forbiddenFilms,language:input.language,repository:fixedRepository,
  options:PRODUCTION_CURATOR_SETTINGS,signal,
 });
 const batch=curatorDecisionBatch(result.decision,curatorSelected,context,input.language,deps.detailToken);
 if(batch.recommendations.length!==12)throw new AppError('NO_NEW_FILMS','More new films could not be found. Your path is unchanged.');
 const stats='stats' in deps.repository&&typeof deps.repository.stats==='function'?deps.repository.stats() as Record<string,unknown>:{};
 const diagnostics={engine:'curator-literature-v2',model:result.model,corpusVersion:context.corpusVersion,documents:Number(stats.documents??0),observations:Number(stats.observations??0),retrievedDocuments:new Set(context.passages.map(p=>p.documentId)).size,retrievedPassages:context.passages.length,usedDocuments:new Set(batch.sources.map(s=>s.documentId??s.id)).size,coveredFilmIds:curatorSelected.filter(film=>context.passages.some(p=>p.filmIds.includes(film.id))).map(film=>film.id),repairAttempted:result.repair.attempted};
 return {batch,seeds,trail,usage:result.usage,model:result.model,contextFingerprint:result.contextFingerprint,contextCoverage:result.contextCoverage,diagnostics,
  timings:{metadataMs,contextMs,modelMs:result.timings.modelMs,repairMs:result.timings.repairMs,candidateResolutionMs:result.timings.resolveMs,totalMs:Date.now()-started,preparationReused:false}};
}
