import {RecommendationInput} from '@/lib/server/recommendation-input';
import {checkOrigin,errorResponse,AppError} from '@/lib/server/config';
import {readLimitedJson} from '@/lib/server/request';

export const runtime='nodejs';
export const maxDuration=5;

export async function POST(request:Request){
 try{
  checkOrigin(request);
  const parsed=RecommendationInput.safeParse(await readLimitedJson(request,2097152));
  if(!parsed.success)throw new AppError('INVALID_INPUT','Choose between one and eight starting films.',400);
  const input=parsed.data;
  if(new Set([...input.seeds,...input.trail]).size!==input.seeds.length+input.trail.length)throw new AppError('DUPLICATE_FILM','A film can appear in your trail only once.',400);
  // Recommendation context is now a bounded local lookup inside the single-call
  // production path. This compatibility response prevents speculative client
  // requests from starting the retired multi-call research pipeline.
  return Response.json({requestId:input.requestId,baseSnapshotId:input.baseSnapshotId,reserveCount:0,prepared:false},{headers:{'Cache-Control':'no-store'}});
 }catch(error){
  if(error instanceof SyntaxError)return errorResponse(new AppError('INVALID_INPUT','The request could not be read.',400));
  return errorResponse(error);
 }
}
