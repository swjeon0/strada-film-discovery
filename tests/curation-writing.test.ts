import test from 'node:test';
import assert from 'node:assert/strict';
import {type Film} from '../lib/domain';
import {CuratedFilm,type Candidate} from '../lib/curation-contract';
import {type Reference} from '../lib/server/source-search';
import {writeCuratedExplanations} from '../lib/server/curation-writing';

type Plan=ReturnType<typeof CuratedFilm.parse>;
type WriteInput={language:string;selected:{code:string;id:string;displayTitle:string}[];approvedConnections:{candidate:string;film:Record<string,unknown>;anchors:string[];decision:string;evidence:{title:string;passage:string;limitedSupport:string}[]}[]};
const PASSAGE='The sustained framing makes the spectator aware of an action continuing outside the image.';
const expanded=(code:string)=>`Expanded explanation for ${code}: the approved formal connection remains a proposal and retains its productive difference.`;
function fixture(count=12){
 const selected:Film[]=[{id:'tmdb:2',title:'Second Selection',titleKo:'두 번째 선택',year:1960,director:'Second Director',poster:''},{id:'tmdb:1',title:'First Selection',titleKo:'첫 번째 선택',year:1950,director:'First Director',poster:''}];
 const plans=new Map<string,Plan>(),verified:{code:string;film:Film;draft:Candidate}[]=[];
 for(let i=0;i<count;i++){
  const code=`c${i}`,film:Film={id:`tmdb:${100+i}`,title:`Approved Film ${i}`,titleKo:`승인 영화 ${i}`,year:1970+i,director:`Director ${i}`,poster:'',overviewEn:'UNAPPROVED_SYNOPSIS_PREMISE must not reach the writer.'};
  const draft:Candidate={title:film.title,year:film.year,director:film.director,lens:'l1',anchors:['a0','a1'],bridge:'A proposed formal bridge.',contrast:'A productive difference.',check:'Keep uncertain details provisional.'};
  plans.set(code,{candidate:code,anchors:['a0','a1'],lens:'Material duration',why:`Approved critical note ${code}: a provisional relationship between framing and offscreen action.`,bridge:draft.bridge,contrast:draft.contrast,evidence:[{ref:'s0',passage:PASSAGE,point:'The source supports the selected-film side of this proposal.'}]});
  verified.push({code,film,draft});
 }
 const reference:Reference={source:{id:'s0',title:'A verified critical essay',publisher:'A Film Journal',author:'A Critic',date:null,url:'https://www.filmcomment.com/article/writing-fixture',type:'criticism',scope:'interpretive_context',summary:'A specific observation in the actual text.',accessLevel:'full_text'},text:PASSAGE+' Its subsequent paragraph qualifies the scope of this observation.',anchorIds:['tmdb:1']};
 return {plans,verified,selected,references:new Map([['s0',reference]])};
}
function isolate(t:{after:(callback:()=>void)=>void}){
 const names=['OPENAI_API_KEY','OPENAI_WRITE_MODEL','OPENAI_WRITE_REASONING'] as const,old=Object.fromEntries(names.map(name=>[name,process.env[name]])),oldFetch=globalThis.fetch;
 process.env.OPENAI_API_KEY='fixture-writing-key-no-live-network';process.env.OPENAI_WRITE_MODEL='fixture-writer';delete process.env.OPENAI_WRITE_REASONING;
 globalThis.fetch=async()=>{throw new Error('Unmocked writer request blocked.');};
 t.after(()=>{globalThis.fetch=oldFetch;for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}});
}
function request(input:RequestInfo|URL,init?:RequestInit){
 assert.equal(String(input),'https://api.openai.com/v1/responses');
 const body=JSON.parse(String(init?.body)) as {model:string;text:{format:{name:string;schema:{properties:{recommendations:{minItems:number;maxItems:number;items:{properties:{candidate:{enum:string[]}}}}}}}};input:{role:string;content:string}[]};
 assert.equal(body.model,'fixture-writer');assert.equal(body.text.format.name,'strada_write_v2');
 const data=JSON.parse(body.input.find(row=>row.role==='user')!.content) as WriteInput;
 const schema=body.text.format.schema.properties.recommendations;
 assert.equal(schema.minItems,data.approvedConnections.length);assert.equal(schema.maxItems,data.approvedConnections.length);
 assert.deepEqual(schema.items.properties.candidate.enum,data.approvedConnections.map(row=>row.candidate));
 return data;
}
function output(rows:unknown[]){return Response.json({status:'completed',model:'fixture-writer',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({recommendations:rows})}]}],usage:{input_tokens:10,output_tokens:20}});}
const normal=(data:WriteInput)=>output(data.approvedConnections.map(row=>({candidate:row.candidate,why:expanded(row.candidate)})));
function run(data:ReturnType<typeof fixture>,signal=new AbortController().signal){return writeCuratedExplanations(data.plans,data.verified,data.selected,data.references,'ko',signal);}

test('twelve explanations start as three four-film groups in parallel and retain the approved order',async t=>{
 isolate(t);const data=fixture(),pending:(()=>void)[]=[],inputs:WriteInput[]=[];
 globalThis.fetch=async(input,init)=>{const value=request(input,init);inputs.push(value);return new Promise<Response>(resolve=>pending.push(()=>resolve(normal(value))));};
 const resultPromise=run(data);
 for(let i=0;i<30&&pending.length<3;i++)await new Promise(resolve=>setImmediate(resolve));
 const started=pending.length;pending.reverse().forEach(resolve=>resolve());const result=await resultPromise;
 assert.equal(started,3);assert.deepEqual(inputs.map(value=>value.approvedConnections.length),[4,4,4]);
 assert.deepEqual([...result.curated.keys()],[...data.plans.keys()]);assert.ok([...result.curated].every(([code,plan])=>plan.why===expanded(code)));
 assert.equal(result.fallback,false);assert.equal(result.usage.inputTokens,30);assert.equal(result.usage.outputTokens,60);
 assert.deepEqual(inputs[0].selected.map(row=>[row.code,row.id,row.displayTitle]),[['a0','tmdb:1','첫 번째 선택'],['a1','tmdb:2','두 번째 선택']]);
});

test('writer output can change only why for approved identities, never anchors, evidence, rank or input state',async t=>{
 isolate(t);const data=fixture(4),original=structuredClone([...data.plans]);
 globalThis.fetch=async(input,init)=>{
  request(input,init);return output([
   {candidate:'invented-candidate',why:expanded('invented-candidate')},
   {candidate:'c1',why:expanded('c1'),anchors:['invented-anchor'],evidence:[{ref:'invented-source'}],rank:0,film:{title:'An injected film'}},
   {candidate:'c0',why:expanded('c0')},
   {candidate:'c0',why:'A duplicate row must not replace the first approved expansion.'},
  ]);
 };
 const result=await run(data);assert.deepEqual([...result.curated.keys()],['c0','c1','c2','c3']);assert.equal(result.curated.has('invented-candidate'),false);
 assert.equal(result.curated.get('c0')?.why,expanded('c0'));assert.equal(result.curated.get('c1')?.why,expanded('c1'));
 assert.deepEqual(result.curated.get('c2'),data.plans.get('c2'));assert.deepEqual(result.curated.get('c3'),data.plans.get('c3'));assert.equal(result.fallback,true);
 for(const [code,plan] of result.curated)assert.deepEqual({...plan,why:data.plans.get(code)!.why},data.plans.get(code));
 assert.deepEqual([...data.plans],original);
});

test('one failed group preserves its approved critical notes while the other two groups complete',async t=>{
 isolate(t);const data=fixture();let calls=0;
 globalThis.fetch=async(input,init)=>{const value=request(input,init);calls++;return value.approvedConnections[0].candidate==='c4'?Response.json({error:{code:'server_error'}},{status:502}):normal(value);};
 const result=await run(data);assert.equal(calls,3);assert.equal(result.fallback,true);assert.equal(result.curated.size,12);
 for(let i=0;i<12;i++)assert.equal(result.curated.get(`c${i}`)?.why,i>=4&&i<8?data.plans.get(`c${i}`)!.why:expanded(`c${i}`));
 assert.equal(result.usage.inputTokens,20);assert.equal(result.usage.outputTokens,40);
});

test('only schema-valid quotations matched against actual text enter writer evidence, and synopsis premises are omitted',async t=>{
 isolate(t);const data=fixture(4),captured:WriteInput[]=[];
 data.plans.get('c0')!.evidence.push({ref:'s0',passage:'A fabricated quotation with a real reference ID.',point:'An unsupported claim.'});
 data.plans.get('c1')!.evidence=[{ref:'not-a-reference',passage:PASSAGE,point:'An invented source.'}];
 data.plans.get('c2')!.evidence=[{ref:'s0',passage:['malformed'],point:'Not a valid passage.'}];
 data.plans.get('c3')!.evidence=[{ref:'s0',passage:PASSAGE,point:''}];
 globalThis.fetch=async(input,init)=>{const value=request(input,init);captured.push(value);return normal(value);};
 await run(data);assert.equal(captured.length,1);
 assert.deepEqual(captured[0].approvedConnections.map(row=>row.evidence.length),[1,0,0,0]);
 assert.equal(captured[0].approvedConnections[0].evidence[0].passage,PASSAGE);
 assert.equal(JSON.stringify(captured).includes('UNAPPROVED_SYNOPSIS_PREMISE'),false);
 assert.ok(captured[0].approvedConnections.every(row=>!('overview' in row.film)));
 assert.ok(captured[0].approvedConnections.every(row=>row.decision===data.plans.get(row.candidate)?.why));
});

test('caller cancellation propagates and aborts all three in-flight writing groups',async t=>{
 isolate(t);const data=fixture(),controller=new AbortController(),signals:AbortSignal[]=[];
 globalThis.fetch=async(input,init)=>{request(input,init);assert.ok(init?.signal);const upstream=init.signal;signals.push(upstream);return new Promise<Response>((_,reject)=>upstream.addEventListener('abort',()=>reject(upstream.reason),{once:true}));};
 const promise=run(data,controller.signal),canceled=assert.rejects(promise,{name:'AbortError'});
 for(let i=0;i<30&&signals.length<3;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(signals.length,3);controller.abort();await canceled;assert.ok(signals.every(signal=>signal.aborted));
});

test('an already-canceled caller starts no writer work',async t=>{
 isolate(t);let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Must not start after cancellation.');};
 const controller=new AbortController();controller.abort();await assert.rejects(run(fixture(),controller.signal),{name:'AbortError'});assert.equal(calls,0);
});

test('a writing-stage timeout keeps the approved notes and reports fallback without canceling the caller',async t=>{
 isolate(t);const data=fixture(4),deadline=new AbortController(),originalTimeout=AbortSignal.timeout;let upstream:AbortSignal|undefined;
 t.mock.method(AbortSignal,'timeout',(ms:number)=>ms===18000?deadline.signal:originalTimeout(ms));
 globalThis.fetch=async(input,init)=>{request(input,init);upstream=init?.signal??undefined;return new Promise<Response>((_,reject)=>upstream?.addEventListener('abort',()=>reject(upstream?.reason),{once:true}));};
 const caller=new AbortController(),promise=run(data,caller.signal);deadline.abort(new DOMException('Writing stage deadline','TimeoutError'));
 const result=await promise;assert.equal(result.fallback,true);assert.equal(caller.signal.aborted,false);assert.equal(upstream?.aborted,true);assert.deepEqual([...result.curated],[...data.plans]);
});
