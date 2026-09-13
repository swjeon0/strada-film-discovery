import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Film,Recommendation} from '../lib/domain';
import {issueDetailToken,explainFilm} from '../lib/server/curation-detail';
import {claimPublicQuota} from '../lib/server/claim-quota';
import {allocateQuota,type QuotaState} from '../lib/server/quota-policy';
import {reserveResearch,reserveDetail} from '../lib/server/request';
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
const expectedCaller=(scope:string)=>createHash('sha256').update(new Date().toISOString().slice(0,10)+':'+scope).digest('hex');
const code=(expected:string)=>(error:unknown)=>error instanceof AppError&&error.code===expected;

test('signed details have their own per-connection caller scope while the global daily cap remains shared',async t=>{
 isolate(t);let state:QuotaState|undefined,models=0;const callers:string[]=[];
 globalThis.fetch=async(input,init)=>{
  if(String(input)===QUOTA){const {caller}=JSON.parse(String(init?.body));callers.push(caller);const allocation=allocateQuota(state,caller,Date.now());state=allocation.state;return Response.json({code:allocation.code},{status:allocation.allowed?200:429});}
  assert.equal(String(input),'https://api.openai.com/v1/responses');models++;return result();
 };
 const ip='detail-scope-test';
 await assert.rejects(explainFilm('forged.token','en',new AbortController().signal,ip),code('INVALID_INPUT'));assert.equal(callers.length,0);
 for(let i=0;i<6;i++)await claimPublicQuota(ip);
 for(let i=0;i<6;i++){
  const signed=token(`A separately signed connection ${i}.`);
  await explainFilm(signed,'en',new AbortController().signal,ip);
  assert.equal(callers.at(-1),expectedCaller(`${ip}:detail:${createHash('sha256').update(signed).digest('hex')}`));
 }
 assert.equal(models,6);assert.equal(state?.total,12);assert.equal(state?.callers[expectedCaller(ip)].count,6);
 await assert.rejects(claimPublicQuota(ip),code('RATE_LIMIT'));
 state!.total=50;
 await assert.rejects(explainFilm(token('A new connection after daily budget exhaustion.'),'en',new AbortController().signal,ip),code('DAILY_LIMIT'));
 assert.equal(models,6);assert.equal(state?.total,50);
});

test('shared detail viewers use one quota/model call and completed details skip paid quota',async t=>{
 isolate(t);let quotaCalls=0,modelCalls=0,resolveModel!:(response:Response)=>void,started!:()=>void,modelSignal:AbortSignal|undefined;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 globalThis.fetch=async(input,init)=>{
  if(String(input)===QUOTA){quotaCalls++;return Response.json({});}
  assert.equal(String(input),'https://api.openai.com/v1/responses');modelCalls++;modelSignal=init?.signal??undefined;started();
  return new Promise<Response>((resolve,reject)=>{resolveModel=resolve;modelSignal?.addEventListener('abort',()=>reject(modelSignal?.reason),{once:true});});
 };
 const signed=token('One explanation shared by simultaneous viewers.'),a=new AbortController(),b=new AbortController();
 const first=explainFilm(signed,'en',a.signal,'first-viewer'),second=explainFilm(signed,'en',b.signal,'second-viewer');
 const canceled=assert.rejects(first,{name:'AbortError'});
 await ready;a.abort();await canceled;assert.equal(modelSignal?.aborted,false);
 resolveModel(result());const value=await second;assert.equal(value.paragraphs.length,3);
 const cached=await explainFilm(signed,'en',new AbortController().signal,'third-viewer');
 assert.equal(cached.cached,true);assert.equal(quotaCalls,1);assert.equal(modelCalls,1);
});

test('last-viewer cancellation aborts model work and neither cancellation nor failure is cached',async t=>{
 isolate(t);let quotaCalls=0,modelCalls=0,started!:()=>void,modelSignal:AbortSignal|undefined;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 globalThis.fetch=async(input,init)=>{
  if(String(input)===QUOTA){quotaCalls++;return Response.json({});}
  assert.equal(String(input),'https://api.openai.com/v1/responses');modelCalls++;
  if(modelCalls===1){modelSignal=init?.signal??undefined;started();return new Promise<Response>((_,reject)=>modelSignal?.addEventListener('abort',()=>reject(modelSignal?.reason),{once:true}));}
  if(modelCalls===2)return Response.json({error:{}},{status:502});
  return result();
 };
 const signed=token('Cancellation and failure must remain retryable.'),a=new AbortController(),b=new AbortController();
 const first=explainFilm(signed,'en',a.signal,'cancel-viewer'),second=explainFilm(signed,'en',b.signal,'cancel-viewer');
 const firstCanceled=assert.rejects(first,{name:'AbortError'}),secondCanceled=assert.rejects(second,{name:'AbortError'});
 await ready;a.abort();await firstCanceled;assert.equal(modelSignal?.aborted,false);
 b.abort();await secondCanceled;assert.equal(modelSignal?.aborted,true);
 await assert.rejects(explainFilm(signed,'en',new AbortController().signal,'cancel-viewer'),code('RESEARCH_ERROR'));
 const retried=await explainFilm(signed,'en',new AbortController().signal,'cancel-viewer');assert.equal(retried.paragraphs.length,3);assert.equal(retried.cached,undefined);
 assert.equal(quotaCalls,3);assert.equal(modelCalls,3);
});

test('local detail and discovery request buckets are separate while concurrency stays shared',t=>{
 isolate(t);const request=new Request('https://strada.example.net/api',{headers:{'cf-connecting-ip':'separate-local-buckets'}});
 for(let i=0;i<24;i++)reserveDetail(request)();
 assert.throws(()=>reserveDetail(request),code('RATE_LIMIT'));
 for(let i=0;i<12;i++)reserveResearch(request)();
 assert.throws(()=>reserveResearch(request),code('RATE_LIMIT'));
 const fresh=new Request('https://strada.example.net/api',{headers:{'cf-connecting-ip':'shared-active-bucket'}});
 const releaseA=reserveResearch(fresh),releaseB=reserveDetail(fresh);
 assert.throws(()=>reserveDetail(fresh),code('RATE_LIMIT'));
 releaseA();releaseA();const releaseC=reserveDetail(fresh);releaseB();releaseC();
});
