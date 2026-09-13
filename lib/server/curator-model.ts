import {config,AppError} from './config';
import {parseCurationOutput} from '../curation-contract';
import {responseUsage} from './source-search';
type ProviderResponse={status?:string,model?:string,usage?:Record<string,unknown>,output?:{type?:string,content?:{type?:string,text?:string}[]}[]};

export async function curatorResponse(stage:'draft'|'curate'|'detail',schema:unknown,prompt:string,input:unknown,signal:AbortSignal,maxTokens:number,timeoutMs:number){
 const conf=config();if(!conf.openai)throw new AppError('SETUP_REQUIRED','AI discovery is not connected.',503);
 const stageSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,timeoutMs))]);
 const started=Date.now();
 const reasoning=/^gpt-5|^o[134]/.test(conf.curatorModel)?{reasoning:{effort:'low'}}:{};
 let response:Response;
 try{response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${conf.openai}`,'Content-Type':'application/json'},signal:stageSignal,body:JSON.stringify({model:conf.curatorModel,store:false,...reasoning,max_output_tokens:maxTokens,text:{format:{type:'json_schema',name:`strada_${stage}_v2`,strict:true,schema}},input:[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}]})});}
 catch(error){if(signal.aborted)throw signal.reason;if(stageSignal.aborted)throw new AppError('TIMEOUT','The curator reached this stage’s time limit.',504);throw error;}
 if(!response.ok){
  let code='';try{const body=await response.json() as {error?:{code?:string}};code=body.error?.code??'';}catch{}
  throw new AppError(response.status===429?'RATE_LIMIT':code==='model_not_found'?'MODEL_UNAVAILABLE':response.status===401?'SETUP_REQUIRED':'RESEARCH_ERROR','AI curation could not finish. Your current path is unchanged.',response.status===429?429:502);
 }
 let data:ProviderResponse;try{data=await response.json() as ProviderResponse;}catch{if(signal.aborted)throw signal.reason;throw new AppError('INVALID_RESEARCH','The curator response could not be read.');}
 if(data.status!=='completed'&&data.status!=='incomplete')throw new AppError('INCOMPLETE','The curator response was incomplete.');
 const raw=(Array.isArray(data.output)?data.output:[]).filter(item=>item?.type==='message').flatMap(item=>Array.isArray(item.content)?item.content:[]).flatMap(item=>item?.type==='output_text'&&typeof item.text==='string'?[item.text]:[]).join('');
 const usage=responseUsage(data,conf.curatorModel);
 console.info('STRADA curator phase',{stage,model:conf.curatorModel,elapsedMs:Date.now()-started,status:data.status,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens});
 const output=parseCurationOutput(raw,stage);if(output===null)throw new AppError('INVALID_RESEARCH','No complete curator response was available.');
 return {output,usage};
}
