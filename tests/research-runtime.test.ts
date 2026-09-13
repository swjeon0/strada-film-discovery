import test from 'node:test';
import assert from 'node:assert/strict';
import {collection} from '../lib/catalogue';
import {research} from '../lib/server/research';

function isolate(t:{after:(fn:()=>void)=>void}){
 const fetch=globalThis.fetch,env={OPENAI_API_KEY:process.env.OPENAI_API_KEY,PUBLIC_MODE:process.env.PUBLIC_MODE,VERCEL:process.env.VERCEL};
 process.env.OPENAI_API_KEY='test-key-never-sent';process.env.PUBLIC_MODE='false';process.env.VERCEL='0';
 t.after(()=>{globalThis.fetch=fetch;for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
}

test('verified GPT picks and real reference links survive a failed explanation call and remain cacheable',async t=>{
 isolate(t);
 const candidates=collection.filter(f=>f.id!=='closeup').slice(0,12).map((film,i)=>({
  title:film.title,year:film.year,director:film.director,
  rationale:'The films on this path study constructed identities and daily performances; this film extends those shared questions through a different cinematic form.',
  discoveryBasis:['d0','d1'],connections:[{anchor:'a0',reason:'A concise connection from the plan.',reasonKo:'계획에서 제시한 연결.',evidence:i<6?[{ref:'s0'}]:[]}],
 }));
 let plans=0,explanations=0;
 globalThis.fetch=async (input,init)=>{
  assert.equal(String(input),'https://api.openai.com/v1/responses');
  const body=JSON.parse(String(init?.body));
  if(body.text.format.name.startsWith('strada_plan_')){
   plans++;
   const raw=`{"candidates":${JSON.stringify(candidates)},"explorations":[{"title":"Unfinished reserve`;
   return Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:raw}]}],usage:{input_tokens:100,output_tokens:70}});
  }
  explanations++;return new Response('',{status:502});
 };
 const discovered=[{id:collection[1].id,title:collection[1].title,year:collection[1].year,director:collection[1].director}];
 const result=await research(['closeup'],[],new AbortController().signal,[],'test-fallback',discovered);
 assert.equal(result.batch.recommendations.length,12);
 assert.equal(result.batch.recommendations.filter(r=>r.sourceIds.length).length,6);
 const global=result.batch.recommendations.filter(r=>r.contextScope==='discovery');
 assert.equal(global.length,6);
 assert.ok(global.every(r=>r.connections[0].why.startsWith('The films on this path')));
 assert.ok(global.every(r=>r.connections[0].whyKo===undefined&&r.sourceIds.length===0));
 assert.equal(result.batch.sources.length,1);
 assert.match(result.batch.sources[0].url,/^https:\/\//);
 const cached=await research(['closeup'],[],new AbortController().signal,[],'test-fallback',discovered);
 assert.equal(cached.usage.cached,true);
 assert.equal(plans,1);assert.equal(explanations,1);
});

test('canceling one shared viewer preserves the job; canceling its last viewer aborts upstream',async t=>{
 isolate(t);
 let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
 let upstreamAborted=false;
 globalThis.fetch=async(input,init)=>{
  assert.equal(String(input),'https://api.openai.com/v1/responses');
  const body=JSON.parse(String(init?.body));assert.ok(body.text.format.name.startsWith('strada_plan_'));
  const signal=init?.signal!;
  return new Promise<Response>((_,reject)=>{
   signal.addEventListener('abort',()=>{upstreamAborted=true;reject(signal.reason);},{once:true});started();
  });
 };
 const first=new AbortController(),second=new AbortController();
 const firstJob=research(['fake'],[],first.signal,[],'test-cancel');
 const secondJob=research(['fake'],[],second.signal,[],'test-cancel');
 const firstRejected=assert.rejects(firstJob,{name:'AbortError'}),secondRejected=assert.rejects(secondJob,{name:'AbortError'});
 await ready;first.abort();await firstRejected;
 assert.equal(upstreamAborted,false);
 second.abort();await secondRejected;
 assert.equal(upstreamAborted,true);
});
