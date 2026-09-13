import test from 'node:test';
import assert from 'node:assert/strict';
import type {Film,Recommendation} from '../lib/domain';
import {issueDetailToken,explainFilm} from '../lib/server/curation-detail';
import {POST} from '../app/api/recommendations/explain/route';
import {AppError} from '../lib/server/config';

const QUOTA='https://quota.example.net/claim';
function isolate(t:{after:(fn:()=>void)=>void}){
 const names=['OPENAI_API_KEY','PUBLIC_MODE','VERCEL','QUOTA_SERVICE_URL','QUOTA_SERVICE_SECRET'];
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]])),fetch=globalThis.fetch;
 Object.assign(process.env,{OPENAI_API_KEY:'test-key-no-live-network',PUBLIC_MODE:'true',VERCEL:'0',QUOTA_SERVICE_URL:QUOTA,QUOTA_SERVICE_SECRET:'test-quota-secret'});
 globalThis.fetch=async()=>{throw new Error('Unexpected network call in detail tests.');};
 t.after(()=>{globalThis.fetch=fetch;for(const [name,value] of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
}
function token(label:string){
 const selected:Film={id:'tmdb:1',title:'An Anchor',year:1952,director:'A Director',poster:''};
 const film:Film={id:'tmdb:2',title:'A Discovery',year:1959,director:'Another Director',poster:''};
 const rec:Recommendation={film,sourceIds:[],connections:[{anchorId:selected.id,anchorTitle:selected.title,relation:'ai_inference',why:label,sourceIds:[]}],curation:{lens:'Everyday rituals',bridge:'A formal connection.',contrast:'A different use of sound.'}};
 return issueDetailToken(rec,[selected],[])!;
}
const result=()=>Response.json({model:'gpt-5.4-mini',status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({paragraphs:['A specific connection between the selected films.','How this film changes that viewing question.','A concrete formal detail to attend to.']})}]}],usage:{input_tokens:100,output_tokens:100}});
const code=(expected:string)=>(error:unknown)=>error instanceof AppError&&error.code===expected;

test('production details accept 60 distinct expansions without a quota service or caller limit',async t=>{
 isolate(t);process.env.VERCEL='1';let models=0;
 globalThis.fetch=async input=>{assert.equal(String(input),'https://api.openai.com/v1/responses');models++;return result();};
 await assert.rejects(explainFilm('forged.token','en',new AbortController().signal),code('INVALID_INPUT'));assert.equal(models,0);
 for(let i=0;i<60;i++){
  const request=new Request('https://strada.example.net/api/recommendations/explain',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://strada.example.net','x-vercel-forwarded-for':'192.0.2.1'},body:JSON.stringify({token:token(`Unlimited connection ${i}.`),language:'en'})});
  const response=await POST(request);assert.equal(response.status,200);assert.equal((await response.json()).paragraphs.length,3);
 }
 assert.equal(models,60);
});

test('shared detail viewers use one model call and completed details reuse the cache',async t=>{
 isolate(t);let modelCalls=0,resolveModel!:(response:Response)=>void,started!:()=>void,modelSignal:AbortSignal|undefined;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://api.openai.com/v1/responses');modelCalls++;modelSignal=init?.signal??undefined;started();
  return new Promise<Response>((resolve,reject)=>{resolveModel=resolve;modelSignal?.addEventListener('abort',()=>reject(modelSignal?.reason),{once:true});});
 };
 const signed=token('One explanation shared by simultaneous viewers.'),a=new AbortController(),b=new AbortController();
 const first=explainFilm(signed,'en',a.signal),second=explainFilm(signed,'en',b.signal);
 const canceled=assert.rejects(first,{name:'AbortError'});
 await ready;a.abort();await canceled;assert.equal(modelSignal?.aborted,false);
 resolveModel(result());const value=await second;assert.equal(value.paragraphs.length,3);
 const cached=await explainFilm(signed,'en',new AbortController().signal);
 assert.equal(cached.cached,true);assert.equal(modelCalls,1);
});

test('last-viewer cancellation aborts model work and neither cancellation nor failure is cached',async t=>{
 isolate(t);let modelCalls=0,started!:()=>void,modelSignal:AbortSignal|undefined;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://api.openai.com/v1/responses');modelCalls++;
  if(modelCalls===1){modelSignal=init?.signal??undefined;started();return new Promise<Response>((_,reject)=>modelSignal?.addEventListener('abort',()=>reject(modelSignal?.reason),{once:true}));}
  if(modelCalls===2)return Response.json({error:{}},{status:502});
  return result();
 };
 const signed=token('Cancellation and failure must remain retryable.'),a=new AbortController(),b=new AbortController();
 const first=explainFilm(signed,'en',a.signal),second=explainFilm(signed,'en',b.signal);
 const firstCanceled=assert.rejects(first,{name:'AbortError'}),secondCanceled=assert.rejects(second,{name:'AbortError'});
 await ready;a.abort();await firstCanceled;assert.equal(modelSignal?.aborted,false);
 b.abort();await secondCanceled;assert.equal(modelSignal?.aborted,true);
 await assert.rejects(explainFilm(signed,'en',new AbortController().signal),code('RESEARCH_ERROR'));
 const retried=await explainFilm(signed,'en',new AbortController().signal);assert.equal(retried.paragraphs.length,3);assert.equal(retried.cached,undefined);
 assert.equal(modelCalls,3);
});

test('independent detail requests can run concurrently without the former two-request cap',async t=>{
 isolate(t);const pending:(()=>void)[]=[];
 globalThis.fetch=async input=>{assert.equal(String(input),'https://api.openai.com/v1/responses');return new Promise<Response>(resolve=>pending.push(()=>resolve(result())));};
 const requests=Array.from({length:4},(_,i)=>POST(new Request('https://strada.example.net/api/recommendations/explain',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://strada.example.net'},body:JSON.stringify({token:token(`Concurrent connection ${i}.`),language:'en'})})));
 for(let i=0;i<20&&pending.length<4;i++)await new Promise(resolve=>setImmediate(resolve));
 const count=pending.length;pending.forEach(resolve=>resolve());
 const responses=await Promise.all(requests);assert.equal(count,4);assert.ok(responses.every(response=>response.status===200));
});
