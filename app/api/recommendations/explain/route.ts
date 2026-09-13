import {z} from 'zod';
import {AppError,checkOrigin,errorResponse} from '@/lib/server/config';
import {readLimitedJson} from '@/lib/server/request';
import {explainFilm} from '@/lib/server/curation-detail';
export const runtime='nodejs';
export const maxDuration=45;
const Input=z.object({token:z.string().min(1).max(16000),language:z.enum(['en','ko'])});
export async function POST(request:Request){try{
 checkOrigin(request);const data=Input.safeParse(await readLimitedJson(request,20000));if(!data.success)throw new AppError('INVALID_INPUT','This explanation request could not be read.',400);
 return Response.json(await explainFilm(data.data.token,data.data.language,AbortSignal.any([request.signal,AbortSignal.timeout(38000)])),{headers:{'Cache-Control':'no-store'}});
 }catch(error){return errorResponse(error);}}
