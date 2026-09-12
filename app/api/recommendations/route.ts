import {z} from 'zod';
import {config,checkOrigin,errorResponse,AppError} from '@/lib/server/config';
import {filmById,recommendCollection} from '@/lib/catalogue';
import {research} from '@/lib/server/research';
import {readLimitedJson,reserveResearch} from '@/lib/server/request';
const Input=z.object({requestId:z.string().min(1).max(100),baseSnapshotId:z.string().nullable(),seeds:z.array(z.string().max(100)).min(1).max(8),trail:z.array(z.string().max(100)).max(30),language:z.enum(['en','ko']).default('en'),seenIds:z.array(z.string().max(100)).max(200).default([])});
export async function POST(r:Request){try{checkOrigin(r);const parsed=Input.safeParse(await readLimitedJson(r));if(!parsed.success)throw new AppError('INVALID_INPUT','Choose between one and eight starting films.',400);const x=parsed.data;if(new Set([...x.seeds,...x.trail]).size!==x.seeds.length+x.trail.length)throw new AppError('DUPLICATE_FILM','A film can appear in your trail only once.',400);
 const conf=config();let result;
 if(conf.openai){const release=reserveResearch(r);try{result=await research(x.seeds,x.trail,r.signal,x.seenIds);}finally{release();}}
 else {const seeds=x.seeds.map(filmById),trail=x.trail.map(filmById);if(seeds.some(f=>!f)||trail.some(f=>!f))throw new AppError('OUTSIDE_COLLECTION','This film is outside the reference collection. Live research is not connected yet.',400);result={seeds:seeds as NonNullable<typeof seeds[number]>[],trail:trail as NonNullable<typeof trail[number]>[],batch:recommendCollection(seeds as NonNullable<typeof seeds[number]>[],trail as NonNullable<typeof trail[number]>[],x.seenIds)};}
 return Response.json({...result.batch,...('usage' in result?{usage:result.usage}:{}),seeds:result.seeds,trail:result.trail,requestId:x.requestId,baseSnapshotId:x.baseSnapshotId,generatedAt:new Date().toISOString()},{headers:{'Cache-Control':'no-store'}});
 }catch(e){if(e instanceof SyntaxError)return errorResponse(new AppError('INVALID_INPUT','The request could not be read.',400));return errorResponse(e);}}
