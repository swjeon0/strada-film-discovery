import {AppError} from './config';
export async function readLimitedJson(request:Request,maxBytes=12000):Promise<unknown>{
 if(Number(request.headers.get('content-length'))>maxBytes)throw new AppError('INVALID_INPUT','This request is too large.',400);
 const reader=request.body?.getReader();if(!reader)throw new AppError('INVALID_INPUT','Choose your starting films first.',400);
 const decoder=new TextDecoder();let bytes=0,text='';
 while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new AppError('INVALID_INPUT','This request is too large.',400);}text+=decoder.decode(part.value,{stream:true});}
 text+=decoder.decode();return JSON.parse(text);
}
