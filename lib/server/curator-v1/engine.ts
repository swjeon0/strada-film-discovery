import type {Film,Language} from '../../domain';
import {sumUsage} from '../source-search';
import type {KnowledgeRepository} from '../knowledge/repository';
import {curateOnce,repairCuratorOnce,type CuratorCallOptions,type CuratorCallResult} from './curate';
import {CuratorIdentityError,resolveCuratorOutput,type ProposalResolver} from './resolve';
import type {CuratorDecision,CuratorV1Request} from './contract';

export type CuratorV1Run={decision:CuratorDecision;contextFingerprint:string;contextPassageCount:number;contextCoverage:Record<string,number>;model:string;usage:CuratorCallResult['usage'];repair:{attempted:boolean;model?:string;indexes?:number[]};timings:{contextMs:number;modelMs:number;resolveMs:number;repairMs:number;totalMs:number}};
export type CuratorV1EngineInput={selected:Film[];excludedIds:string[];forbiddenFilms?:Pick<Film,'id'|'title'|'year'|'director'>[];language:Language;repository:KnowledgeRepository;options:CuratorCallOptions;signal:AbortSignal};
export type CuratorV1Dependencies={curate:typeof curateOnce;repair:typeof repairCuratorOnce;resolve:typeof resolveCuratorOutput};

export async function runCuratorV1(input:CuratorV1EngineInput,dependencies:Partial<CuratorV1Dependencies>={},resolver?:ProposalResolver):Promise<CuratorV1Run>{
 const deps:CuratorV1Dependencies={curate:curateOnce,repair:repairCuratorOnce,resolve:resolveCuratorOutput,...dependencies};
 const started=Date.now(),contextStarted=Date.now();
 const context=await input.repository.buildContext(input.selected,input.language),contextMs=Date.now()-contextStarted;
 const request:CuratorV1Request={selected:input.selected,excludedIds:[...new Set([...input.excludedIds,...input.selected.map(film=>film.id)])],forbiddenFilms:input.forbiddenFilms,language:input.language,context};
 const result=await deps.curate(request,input.options,input.signal);let output=result.output,usage=result.usage,repairMs=0,repair:{attempted:boolean;model?:string;indexes?:number[]}={attempted:false};
 const resolveStarted=Date.now();let decision:CuratorDecision;
 try{decision=await deps.resolve(output,request.excludedIds,input.signal,resolver);}catch(error){
  if(!(error instanceof CuratorIdentityError)||!input.options.repair||!error.details.invalidIndexes.length)throw error;
  const repairStarted=Date.now(),fixed=await deps.repair(request,output,error.details.invalidIndexes,input.options.repair,input.signal);repairMs=Date.now()-repairStarted;
  output=fixed.output;usage=sumUsage(usage,fixed.usage);repair={attempted:true,model:fixed.model,indexes:error.details.invalidIndexes};
  decision=await deps.resolve(output,request.excludedIds,input.signal,resolver);
 }
 const resolveMs=Date.now()-resolveStarted-repairMs;
 const contextCoverage=Object.fromEntries(input.selected.map(film=>[film.id,context.passages.filter(passage=>passage.filmIds.includes(film.id)).length]));
 return {decision,contextFingerprint:input.repository.fingerprint(),contextPassageCount:context.passages.length,contextCoverage,model:result.model,usage,repair,
  timings:{contextMs,modelMs:result.elapsedMs,resolveMs,repairMs,totalMs:Date.now()-started}};
}
