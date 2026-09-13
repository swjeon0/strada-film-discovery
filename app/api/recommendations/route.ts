import {z} from 'zod';
import {checkOrigin,errorResponse,AppError} from '@/lib/server/config';
import {research} from '@/lib/server/research';
import {readLimitedJson,reserveResearch,requestIp} from '@/lib/server/request';
export const runtime='nodejs';
export const maxDuration=300;
const Input=z.object({requestId:z.string().min(1).max(100),baseSnapshotId:z.string().nullable(),seeds:z.array(z.string().max(100)).min(1).max(8),trail:z.array(z.string().max(100)).max(30),language:z.enum(['en','ko']).default('en'),seenIds:z.array(z.string().max(100)).max(400).default([]),discoveredFilms:z.array(z.object({id:z.string().min(1).max(100),title:z.string().min(1).max(240),year:z.number().int().min(1850).max(2200),director:z.string().max(240)})).max(400).default([])});
export async function POST(r:Request){try{checkOrigin(r);const parsed=Input.safeParse(await readLimitedJson(r,262144));if(!parsed.success)throw new AppError('INVALID_INPUT','Choose between one and eight starting films.',400);const x=parsed.data;if(new Set([...x.seeds,...x.trail]).size!==x.seeds.length+x.trail.length)throw new AppError('DUPLICATE_FILM','A film can appear in your trail only once.',400);
 const release=reserveResearch(r);let result;try{result=await research(x.seeds,x.trail,r.signal,x.seenIds,requestIp(r),x.discoveredFilms);}finally{release();}
 return Response.json({...result.batch,...('usage' in result?{usage:result.usage}:{}),seeds:result.seeds,trail:result.trail,requestId:x.requestId,baseSnapshotId:x.baseSnapshotId,generatedAt:new Date().toISOString()},{headers:{'Cache-Control':'no-store'}});
 }catch(e){if(e instanceof SyntaxError)return errorResponse(new AppError('INVALID_INPUT','The request could not be read.',400));return errorResponse(e);}}
