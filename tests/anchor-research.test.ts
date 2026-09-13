import test from 'node:test';
import assert from 'node:assert/strict';
import type {Film} from '../lib/domain';
import {peekAnchorReferences,prepareAnchorReferences} from '../lib/server/anchor-research';

const controller=()=>new AbortController();
const film=(label:string,index=0):Film=>({id:`anchor-${label}-${index}`,title:`Selected Film ${label} ${index}`,year:1950+index,director:`Director ${index}`,poster:''});
const article=(title:string)=>`<html><head><title>${title}</title><meta name="author" content="A Film Critic"></head><body><article><h1>${title}</h1><p>${`${title} uses duration and framing to make everyday cinema attentive to social history. This film criticism follows the director's camera, editing and sound rather than reducing the film to a plot summary. `.repeat(4)}</p><p>${'The tension between a visible landscape and an unseen action changes how the spectator reads the sequence. The essay relates this formal device to historical conditions and discusses the limits of that interpretation. '.repeat(3)}</p></article></body></html>`;
const response=(title:string,url:string)=>Response.json({model:'gpt-4.1-mini',output:[{type:'web_search_call',action:{sources:[{url,title}]}}],usage:{input_tokens:150,output_tokens:50}});
function requestedFilm(init?:RequestInit){const body=JSON.parse(String(init?.body)),query=JSON.parse(body.input[1].content);assert.equal(query.purpose,'anchor');assert.equal(query.films.length,1);return query.films[0] as {title:string};}
function installImmediate(t:{mock:{method:typeof test.mock.method}},onSearch:(title:string)=>void=()=>{}){
 const titles=new Map<string,string>();
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input)==='https://api.openai.com/v1/responses'){
   const selected=requestedFilm(init),url=`https://www.filmcomment.com/article/${encodeURIComponent(selected.title)}`;
   onSearch(selected.title);titles.set(url,selected.title);return response(selected.title,url);
  }
  const title=titles.get(String(input));assert.ok(title,`Unexpected network call: ${input}`);
  return new Response(article(title),{headers:{'Content-Type':'text/html'}});
 });
}

test('every one of four selected films starts its own source search concurrently',async t=>{
 const films=Array.from({length:4},(_,i)=>film('parallel',i)),pending:(()=>void)[]=[],titles=new Map<string,string>();
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input)==='https://api.openai.com/v1/responses'){
   const selected=requestedFilm(init),url=`https://www.filmcomment.com/article/${encodeURIComponent(selected.title)}`;titles.set(url,selected.title);
   return new Promise<Response>(resolve=>pending.push(()=>resolve(response(selected.title,url))));
  }
  const title=titles.get(String(input));assert.ok(title);return new Response(article(title),{headers:{'Content-Type':'text/html'}});
 });
 const output=prepareAnchorReferences(films,{remaining:32},controller().signal);
 for(let i=0;i<20&&pending.length<4;i++)await new Promise(resolve=>setImmediate(resolve));
 const started=pending.length;pending.forEach(resolve=>resolve());const result=await output;
 assert.equal(started,4);assert.equal(result.usage.searchCalls,4);
 assert.deepEqual(result.coveredFilmIds,films.map(f=>f.id));assert.equal(result.references.length,4);
 assert.ok(result.references.every(reference=>reference.text.includes('duration and framing')));
});

test('regeneration reuses actual per-film readings and reports no new paid usage',async t=>{
 let searches=0;installImmediate(t,()=>searches++);
 const selected=film('cache'),first=await prepareAnchorReferences([selected],{remaining:8},controller().signal);
 const second=await prepareAnchorReferences([selected],{remaining:0},controller().signal);
 assert.equal(searches,1);assert.equal(first.usage.searchCalls,1);assert.ok(first.usage.estimatedUsd>0);
 assert.equal(second.usage.searchCalls,0);assert.equal(second.usage.inputTokens,0);assert.equal(second.usage.estimatedUsd,0);
 assert.deepEqual(second.cachedFilmIds,[selected.id]);assert.deepEqual(second.searchedFilmIds,[]);assert.deepEqual(second.references,first.references);
});

test('drafts can peek cached passages synchronously without requests, mutable cache access or stale model data',async t=>{
 let searches=0;installImmediate(t,()=>searches++);const selected=film('peek'),missing=film('peek-missing');
 assert.deepEqual(peekAnchorReferences([selected]),[]);
 const prepared=await prepareAnchorReferences([selected],{remaining:8},controller().signal);
 const peeked=peekAnchorReferences([selected,missing]);assert.deepEqual(peeked,prepared.references);assert.equal(searches,1);
 peeked[0].text='Caller shortened this excerpt.';peeked[0].source.title='Caller replaced the title.';peeked[0].anchorIds.length=0;
 assert.deepEqual(peekAnchorReferences([selected]),prepared.references);
 const originalModel=process.env.OPENAI_SEARCH_MODEL;process.env.OPENAI_SEARCH_MODEL='a-different-search-model';
 try{assert.deepEqual(peekAnchorReferences([selected]),[]);}finally{if(originalModel===undefined)delete process.env.OPENAI_SEARCH_MODEL;else process.env.OPENAI_SEARCH_MODEL=originalModel;}
 const now=Date.now();t.mock.method(Date,'now',()=>now+86_400_001);
 assert.deepEqual(peekAnchorReferences([selected]),[]);assert.equal(searches,1);
});

test('a longer path covers deferred films next while retaining earlier cached readings',async t=>{
 const searched:string[]=[];installImmediate(t,title=>searched.push(title));
 const films=Array.from({length:6},(_,i)=>film('balanced',i));
 const first=await prepareAnchorReferences([...films].reverse(),{remaining:32},controller().signal);
 assert.deepEqual(first.searchedFilmIds,films.slice(0,4).map(f=>f.id));assert.deepEqual(first.deferredFilmIds,films.slice(4).map(f=>f.id));
 const second=await prepareAnchorReferences(films,{remaining:32},controller().signal);
 assert.deepEqual(second.searchedFilmIds,films.slice(4).map(f=>f.id));assert.deepEqual(second.coveredFilmIds,films.map(f=>f.id));
 assert.equal(second.cachedFilmIds.length,4);assert.equal(searched.length,6);assert.equal(second.usage.searchCalls,2);
});

test('failed long-path searches rotate toward unsearched films without trail-order preference',async t=>{
 const searched:string[]=[];
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{assert.equal(String(input),'https://api.openai.com/v1/responses');searched.push(requestedFilm(init).title);return Response.json({output:[{type:'web_search_call',action:{sources:[]}}]});});
 const films=Array.from({length:6},(_,i)=>film('fair-failure',i));
 const first=await prepareAnchorReferences(films,{remaining:32},controller().signal);
 const second=await prepareAnchorReferences([...films].reverse(),{remaining:32},controller().signal);
 assert.deepEqual(first.searchedFilmIds,films.slice(0,4).map(f=>f.id));
 assert.deepEqual(second.searchedFilmIds.slice(0,2),films.slice(4).map(f=>f.id));assert.equal(second.coveredFilmIds.length,0);
 assert.equal(searched.length,8);
});

test('concurrent callers share one search, and canceling the first preserves the other caller',async t=>{
 const selected=film('shared'),url='https://www.filmcomment.com/article/anchor-shared';let searches=0,resolveSearch!:(value:Response)=>void,modelSignal:AbortSignal|undefined;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input)==='https://api.openai.com/v1/responses'){requestedFilm(init);searches++;modelSignal=init?.signal??undefined;return new Promise<Response>((resolve,reject)=>{resolveSearch=resolve;modelSignal?.addEventListener('abort',()=>reject(modelSignal?.reason),{once:true});});}
  assert.equal(String(input),url);return new Response(article(selected.title),{headers:{'Content-Type':'text/html'}});
 });
 const a=controller(),b=controller(),first=prepareAnchorReferences([selected],{remaining:8},a.signal),second=prepareAnchorReferences([selected],{remaining:8},b.signal);
 const canceled=assert.rejects(first,{name:'AbortError'});a.abort();await canceled;assert.equal(modelSignal?.aborted,false);
 resolveSearch(response(selected.title,url));const result=await second;
 assert.equal(searches,1);assert.equal(result.usage.searchCalls,1);assert.deepEqual(result.coveredFilmIds,[selected.id]);
});

test('simultaneous successful subscribers account for one paid result in total',async t=>{
 let searches=0;installImmediate(t,()=>searches++);const selected=film('usage-once');
 const [a,b]=await Promise.all([prepareAnchorReferences([selected],{remaining:8},controller().signal),prepareAnchorReferences([selected],{remaining:8},controller().signal)]);
 assert.equal(searches,1);assert.equal(a.usage.searchCalls+b.usage.searchCalls,1);assert.equal(a.references.length,1);assert.equal(b.references.length,1);
});

test('last caller cancellation aborts retrieval and permits an immediate fresh retry',async t=>{
 const selected=film('cancel-retry'),url='https://www.filmcomment.com/article/anchor-cancel-retry';let searches=0,modelSignal:AbortSignal|undefined;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input)==='https://api.openai.com/v1/responses'){
   searches++;modelSignal=init?.signal??undefined;
   if(searches===1)return new Promise<Response>((_,reject)=>modelSignal?.addEventListener('abort',()=>reject(modelSignal?.reason),{once:true}));
   return response(selected.title,url);
  }
  assert.equal(String(input),url);return new Response(article(selected.title),{headers:{'Content-Type':'text/html'}});
 });
 const caller=controller(),first=prepareAnchorReferences([selected],{remaining:8},caller.signal),canceled=assert.rejects(first,{name:'AbortError'});
 caller.abort();await canceled;assert.equal(modelSignal?.aborted,true);
 const result=await prepareAnchorReferences([selected],{remaining:8},controller().signal);
 assert.equal(searches,2);assert.deepEqual(result.coveredFilmIds,[selected.id]);
});

test('the 15-second stage deadline releases the caller with partial readings and aborts unused work',async t=>{
 const selected=film('deadline'),deadline=controller(),originalTimeout=AbortSignal.timeout;let modelSignal:AbortSignal|undefined;
 t.mock.method(AbortSignal,'timeout',(ms:number)=>ms===15_000?deadline.signal:originalTimeout(ms));
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{assert.equal(String(input),'https://api.openai.com/v1/responses');modelSignal=init?.signal??undefined;return new Promise<Response>((_,reject)=>modelSignal?.addEventListener('abort',()=>reject(modelSignal?.reason),{once:true}));});
 const resultPromise=prepareAnchorReferences([selected],{remaining:8},controller().signal);
 deadline.abort(new DOMException('Anchor research deadline','TimeoutError'));
 const result=await resultPromise;assert.equal(result.references.length,0);assert.equal(modelSignal?.aborted,true);
 assert.deepEqual(result.searchedFilmIds,[selected.id]);assert.ok(result.elapsedMs<1000);
});

test('no document budget starts no search; snippets and unreadable pages are never cached as evidence',async t=>{
 const selected=film('no-evidence');let calls=0;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{calls++;assert.equal(String(input),'https://api.openai.com/v1/responses');return Response.json({output:[{type:'message',content:[{type:'output_text',text:'An invented film review URL and a plausible critical quotation.'}]}]});});
 const zero=await prepareAnchorReferences([selected],{remaining:0},controller().signal);
 assert.equal(calls,0);assert.deepEqual(zero.deferredFilmIds,[selected.id]);
 const first=await prepareAnchorReferences([selected],{remaining:8},controller().signal),second=await prepareAnchorReferences([selected],{remaining:8},controller().signal);
 assert.equal(calls,2);assert.equal(first.references.length,0);assert.equal(second.cachedFilmIds.length,0);assert.equal(second.coveredFilmIds.length,0);
});
