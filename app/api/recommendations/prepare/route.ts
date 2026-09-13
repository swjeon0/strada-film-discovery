import {criticalPlan,usableDecision} from '@/lib/server/critical-plan';
import {issuePreparationToken} from '@/lib/server/preparation-token';
import {sumUsage} from '@/lib/server/source-search';
import {RecommendationInput} from '@/lib/server/recommendation-input';
import {checkOrigin,errorResponse,AppError} from '@/lib/server/config';
import {prepareResearch,eligiblePreparedCandidates} from '@/lib/server/preparation';
import {readLimitedJson} from '@/lib/server/request';
export const runtime='nodejs';
export const maxDuration=100;
export async function POST(request:Request){
 try{
  checkOrigin(request);
  const started=Date.now(),signal=AbortSignal.any([request.signal,AbortSignal.timeout(85000)]);
  const parsed=RecommendationInput.safeParse(await readLimitedJson(request,2097152));
  if(!parsed.success)throw new AppError('INVALID_INPUT','Choose between one and eight starting films.',400);
  const x=parsed.data;
  if(new Set([...x.seeds,...x.trail]).size!==x.seeds.length+x.trail.length)throw new AppError('DUPLICATE_FILM','A film can appear in your trail only once.',400);
  const options={intent:x.intent,previousIds:x.previousIds,language:x.language,preparationToken:x.preparationToken};
  const seenIds=[...new Set([...x.seenIds,...x.discoveredFilms.map(f=>f.id)])];
  const result=await prepareResearch(x.seeds,x.trail,signal,seenIds,x.discoveredFilms,options);
  const films=[...result.seeds,...result.trail];
  if(!usableDecision(result.preparation,films,seenIds,options)){
   try{
    const planned=await criticalPlan(result.preparation,films,seenIds,options,signal,Math.min(40000,85000-(Date.now()-started)));
    result.preparation={...result.preparation,decision:planned.decision};
    result.preparationToken=issuePreparationToken(result.preparation);
    result.usage=sumUsage(result.usage,planned.usage);result.timings.selectionMs=planned.elapsedMs;
   }catch(error){if(request.signal.aborted)throw request.signal.reason;console.warn('STRADA background decision unavailable',{error:error instanceof AppError?error.code:error instanceof Error?error.name:'unknown'});}
  }else result.timings.decisionReused=true;
  result.timings.totalMs=Date.now()-started;
  if(!result.preparationToken)throw new AppError('PREPARATION_UNAVAILABLE','The candidate preparation could not be retained.',503);
  return Response.json({requestId:x.requestId,baseSnapshotId:x.baseSnapshotId,preparationToken:result.preparationToken,reserveCount:eligiblePreparedCandidates(result.preparation,x.seenIds,options).length,timings:result.timings,usage:result.usage},{headers:{'Cache-Control':'no-store'}});
 }catch(error){if(error instanceof SyntaxError)return errorResponse(new AppError('INVALID_INPUT','The request could not be read.',400));return errorResponse(error);}
}
