import {config,AppError} from './config';
import {parseCurationOutput} from '../curation-contract';
import {responseUsage} from './source-search';
import {curationSettings,type CurationStage} from './curation-settings';
type ProviderResponse={status?:string,model?:string,usage?:Record<string,unknown>,output?:{type?:string,content?:{type?:string,text?:string}[]}[]};

export async function curatorResponse(stage:CurationStage,schema:unknown,prompt:string,input:unknown,signal:AbortSignal,maxTokens:number,timeoutMs:number){
 const conf=config();if(!conf.openai)throw new AppError('SETUP_REQUIRED','AI discovery is not connected.',503);
 const settings=curationSettings({basePrompts:{[stage]:prompt}}),selected=settings.stages[stage];
 const stageSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,timeoutMs))]);
 const started=Date.now();
 const reasoning=selected.reasoning===null?{}:{reasoning:{effort:selected.reasoning}};
 let response:Response;
 try{response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${conf.openai}`,'Content-Type':'application/json'},signal:stageSignal,body:JSON.stringify({model:selected.model,store:false,...reasoning,max_output_tokens:maxTokens,text:{format:{type:'json_schema',name:`strada_${stage}_v2`,strict:true,schema}},input:[{role:'system',content:settings.prompts[stage]},{role:'user',content:JSON.stringify(input)}]})});}
 catch(error){if(signal.aborted)throw signal.reason;if(stageSignal.aborted)throw new AppError('TIMEOUT','The curator reached this stage’s time limit.',504);throw error;}
 if(!response.ok){
  let code='';try{const body=await response.json() as {error?:{code?:string}};code=body.error?.code??'';}catch{}
  throw new AppError(response.status===429?'RATE_LIMIT':code==='model_not_found'?'MODEL_UNAVAILABLE':response.status===401?'SETUP_REQUIRED':'RESEARCH_ERROR','AI curation could not finish. Your current path is unchanged.',response.status===429?429:502);
 }
 let data:ProviderResponse;try{data=await response.json() as ProviderResponse;}catch{if(signal.aborted)throw signal.reason;throw new AppError('INVALID_RESEARCH','The curator response could not be read.');}
 if(data.status!=='completed'&&data.status!=='incomplete')throw new AppError('INCOMPLETE','The curator response was incomplete.');
 const raw=(Array.isArray(data.output)?data.output:[]).filter(item=>item?.type==='message').flatMap(item=>Array.isArray(item.content)?item.content:[]).flatMap(item=>item?.type==='output_text'&&typeof item.text==='string'?[item.text]:[]).join('');
 const model=data.model??selected.model,elapsedMs=Date.now()-started,usage=responseUsage(data,model);
 console.info('STRADA curator phase',{stage,model,reasoning:selected.reasoning,elapsedMs,settingsFingerprint:settings.stageFingerprints[stage],status:data.status,visibleOutputChars:raw.length,reasoningTokens:(data.usage?.output_tokens_details as {reasoning_tokens?:number}|undefined)?.reasoning_tokens??0,inputTokens:usage.inputTokens,outputTokens:usage.outputTokens});
 const output=parseCurationOutput(raw,stage==='write'?'detail':stage);if(output===null)throw new AppError('INVALID_RESEARCH','No complete curator response was available.');
 return {output,usage,stage,model,elapsedMs,settingsFingerprint:settings.stageFingerprints[stage]};
}
