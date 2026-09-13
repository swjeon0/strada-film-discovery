import {AppError} from './config';
export async function readLimitedJson(request:Request,maxBytes=12000):Promise<unknown>{
 if(Number(request.headers.get('content-length'))>maxBytes)throw new AppError('INVALID_INPUT','This request is too large.',400);
 const reader=request.body?.getReader();if(!reader)throw new AppError('INVALID_INPUT','Choose your starting films first.',400);
 const decoder=new TextDecoder();let bytes=0,text='';
 while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new AppError('INVALID_INPUT','This request is too large.',400);}text+=decoder.decode(part.value,{stream:true});}
 text+=decoder.decode();return JSON.parse(text);
}
export function requestIp(request:Request){
 if(process.env.VERCEL==='1')return request.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim()||request.headers.get('x-forwarded-for')?.split(',')[0].trim()||'unknown';
 return request.headers.get('cf-connecting-ip')??'local';
}
// Local concurrency guard; a shared authenticated service enforces the public daily budget.
const callers=new Map<string,{started:number,count:number}>();let active=0;
export function reserveResearch(request:Request){
 const now=Date.now();const key=requestIp(request);const previous=callers.get(key);const bucket=previous&&now-previous.started<600000?previous:{started:now,count:0};
 if(active>=2||bucket.count>=12)throw new AppError('RATE_LIMIT','Research is busy. Please try again in a few minutes.',429);
 if(callers.size>1000)callers.clear();bucket.count++;callers.set(key,bucket);active++;let released=false;return()=>{if(!released){active--;released=true;}};
}
