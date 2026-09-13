import test from 'node:test';
import assert from 'node:assert/strict';
import {curatorResponse} from '../lib/server/curator-model';
import {AppError} from '../lib/server/config';
import {curationSettings} from '../lib/server/curation-settings';

function isolate(t:{after:(fn:()=>void)=>void}){
 const names=new Set(['OPENAI_API_KEY','STRADA_PROFILE',...Object.keys(process.env).filter(key=>/^OPENAI_(?:(?:DRAFT|SELECT|WRITE|DETAIL|SEARCH|CURATOR)_(?:MODEL|REASONING)|MODEL)$/.test(key))]);
 for(const prefix of ['DRAFT','SELECT','WRITE','DETAIL','SEARCH','CURATOR'])for(const suffix of ['MODEL','REASONING'])names.add(`OPENAI_${prefix}_${suffix}`);
 names.add('OPENAI_MODEL');
 const prior=new Map([...names].map(name=>[name,process.env[name]]));
 for(const name of names)delete process.env[name];
 process.env.OPENAI_API_KEY='fake-unit-test-key-never-sent';
 const previousFetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('Every external request must be explicitly mocked.');};
 t.after(()=>{globalThis.fetch=previousFetch;for(const [name,value]of prior){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
}

test('Responses requests use each stage model, explicit effort and effective prompt, returning actual model timing',async t=>{
 isolate(t);
 const calls:{model:string,reasoning?:{effort:string},input:{content:string}[]}[]=[];
 globalThis.fetch=async(url,options)=>{
  assert.equal(url,'https://api.openai.com/v1/responses');
  const body=JSON.parse(String(options?.body));calls.push(body);
  return Response.json({status:'completed',model:body.model+'-snapshot',usage:{input_tokens:100,output_tokens:10},output:[{type:'message',content:[{type:'output_text',text:'{"valid":true}'}]}]});
 };
 for(const stage of ['draft','curate','write','detail'] as const){
  const result=await curatorResponse(stage,{type:'object'},'Test base prompt',{film:'A selected identity'},new AbortController().signal,100,1000);
  const settings=curationSettings({basePrompts:{[stage]:'Test base prompt'}}),sent=calls.at(-1)!;
  assert.equal(sent.model,settings.stages[stage].model);
  assert.equal(sent.reasoning?.effort,'low');
  assert.equal(sent.input[0].content,settings.prompts[stage]);
  assert.deepEqual(result.output,{valid:true});
  assert.equal(result.stage,stage);
  assert.equal(result.model,sent.model+'-snapshot');
  assert.ok(result.elapsedMs>=0);
  assert.equal(result.settingsFingerprint,settings.stageFingerprints[stage]);
 }
});

test('non-reasoning model override omits reasoning instead of sending an invalid parameter',async t=>{
 isolate(t);process.env.OPENAI_DETAIL_MODEL='gpt-4.1-mini';
 globalThis.fetch=async(_url,options)=>{
  const body=JSON.parse(String(options?.body));assert.equal(body.model,'gpt-4.1-mini');assert.equal('reasoning' in body,false);
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"paragraphs":["a","b","c"]}'}]}]});
 };
 const result=await curatorResponse('detail',{},'Test detail',{},new AbortController().signal,100,1000);
 assert.equal(result.model,'gpt-4.1-mini');
});

test('stage timeout still aborts the provider request with a retryable application error',async t=>{
 isolate(t);
 globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>{
  options!.signal!.addEventListener('abort',()=>reject(options!.signal!.reason),{once:true});
 });
 // Keep the event loop alive while testing AbortSignal.timeout's unref'ed timer.
 const alive=setTimeout(()=>{},1000);
 try{await assert.rejects(curatorResponse('draft',{},'Test',{},new AbortController().signal,100,20),error=>error instanceof AppError&&error.code==='TIMEOUT'&&error.status===504);}
 finally{clearTimeout(alive);}
});
