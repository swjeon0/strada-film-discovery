import test from 'node:test';
import assert from 'node:assert/strict';
import {type Film,type ResearchOptions} from '../lib/domain';
import {criticalPlan,decisionFingerprint,usableDecision} from '../lib/server/critical-plan';
import {issuePreparationToken,readPreparationToken,type Preparation} from '../lib/server/preparation-token';
import {AppError} from '../lib/server/config';

function fixture(){
 const films:Film[]=[{id:'tmdb:2',title:'Second Selection',titleKo:'두 번째 선택',year:1960,director:'Second Director',poster:''},{id:'tmdb:1',title:'First Selection',titleKo:'첫 번째 선택',year:1950,director:'First Director',poster:''}];
 const preparation:Preparation={version:1,issued:Date.now(),fingerprint:'fixture-draft-search-context',language:'ko',selected:films,lenses:[{id:'l1',label:'Material duration',question:'How do framing and duration construct different kinds of attention?',anchors:['a0','a1']}],queries:[],candidates:Array.from({length:12},(_,i)=>({code:`c${i}`,film:{id:`tmdb:${100+i}`,title:`Candidate ${i}`,titleKo:`후보 ${i}`,year:1970+i,director:`Director ${i}`,poster:''},draft:{title:`Candidate ${i}`,year:1970+i,director:`Director ${i}`,lens:'l1',anchors:['a0','a1'],bridge:'An approved provisional bridge through a specific formal operation.',contrast:'A productive difference.',check:'Keep precise formal claims provisional.'}})),references:[{source:{id:'s0',title:'A verified critical reading',publisher:'Film Journal',author:'A Critic',date:null,url:'https://www.filmcomment.com/article/critical-plan-test',type:'criticism',scope:'interpretive_context',summary:'A limited critical observation.',accessLevel:'full_text'},text:'The sustained framing shifts attention toward the duration of an offscreen action. This actual passage supports the selected-film side of a comparison.',anchorIds:['tmdb:1']}],coveredFilmIds:['tmdb:1']};
 const options:ResearchOptions={intent:'follow',language:'ko',previousIds:['tmdb:101','tmdb:100']};
 return {films,preparation,options,seen:['tmdb:999','tmdb:998']};
}
function isolate(t:{after:(callback:()=>void)=>void}){
 const names=['OPENAI_API_KEY','OPENAI_SELECT_MODEL','OPENAI_WRITE_MODEL'] as const,old=Object.fromEntries(names.map(name=>[name,process.env[name]])),oldFetch=globalThis.fetch;
 process.env.OPENAI_API_KEY='critical-plan-test-signing-key';process.env.OPENAI_SELECT_MODEL='fixture-critical-model';process.env.OPENAI_WRITE_MODEL='fixture-writing-model';
 globalThis.fetch=async()=>{throw new Error('Unexpected critical-plan network request.');};
 t.after(()=>{globalThis.fetch=oldFetch;for(const name of names){if(old[name]===undefined)delete process.env[name];else process.env[name]=old[name];}});
}
type CriticalInput={selected:{code:string;id:string;displayTitle:string;weight:number}[];references:{code:string;excerpt:string}[];verifiedCandidates:{code:string;id:string}[];freshness:{previousIds:string[]}};
function request(input:RequestInfo|URL,init?:RequestInit){
 assert.equal(String(input),'https://api.openai.com/v1/responses');
 const body=JSON.parse(String(init?.body)) as {max_output_tokens:number;text:{format:{name:string}};input:{role:string;content:string}[]};
 assert.equal(body.text.format.name,'strada_curate_v2');assert.equal(body.max_output_tokens,3600);
 return JSON.parse(body.input.find(row=>row.role==='user')!.content) as CriticalInput;
}
function output(value:unknown){return Response.json({status:'completed',model:'fixture-critical-model',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:20,output_tokens:30}});}
function response(data:CriticalInput){return {readings:[],ranking:data.verifiedCandidates.map(row=>row.code),recommendations:data.verifiedCandidates.map(row=>({candidate:row.code,anchors:['a0','a1'],why:'A specific formal relation joins the two selected films while introducing a productive difference.',evidence:[]})),rejected:[]};}

test('a signed critical decision is reusable for the same whole context across request order and writer changes',async t=>{
 isolate(t);const data=fixture();let calls=0;
 globalThis.fetch=async(input,init)=>{const value=request(input,init);calls++;assert.deepEqual(value.selected.map(row=>[row.code,row.id,row.displayTitle,row.weight]),[['a0','tmdb:1','첫 번째 선택',.5],['a1','tmdb:2','두 번째 선택',.5]]);assert.equal(value.references[0].excerpt,data.preparation.references[0].text);return output(response(value));};
 const result=await criticalPlan(data.preparation,data.films,data.seen,data.options,new AbortController().signal);
 const prepared={...data.preparation,decision:result.decision};assert.ok(usableDecision(prepared,data.films,data.seen,data.options));
 assert.equal(result.decision.contextFingerprint,decisionFingerprint(prepared,[...data.films].reverse(),[...data.seen].reverse(),{...data.options,previousIds:[...data.options.previousIds].reverse()}));
 process.env.OPENAI_WRITE_MODEL='a-different-writer';assert.ok(usableDecision(prepared,data.films,data.seen,data.options));
 const token=issuePreparationToken(prepared);assert.ok(token);
 const restored=readPreparationToken(token,data.films,'ko',data.preparation.fingerprint);assert.ok(restored);
 assert.deepEqual(usableDecision(restored,data.films,data.seen,data.options),result.decision);assert.equal(calls,1);
});

test('selection configuration, history, language, selected films, candidate pool and source changes invalidate a stored decision',async t=>{
 isolate(t);const data=fixture();globalThis.fetch=async(input,init)=>output(response(request(input,init)));
 const result=await criticalPlan(data.preparation,data.films,data.seen,data.options,new AbortController().signal),prepared={...data.preparation,decision:result.decision};
 assert.equal(usableDecision(prepared,data.films,[...data.seen,'tmdb:997'],data.options),null);
 assert.equal(usableDecision(prepared,data.films,data.seen,{...data.options,language:'en'}),null);
 assert.equal(usableDecision(prepared,data.films,data.seen,{...data.options,intent:'regenerate'}),null);
 assert.equal(usableDecision(prepared,data.films,data.seen,{...data.options,previousIds:[]}),null);
 assert.equal(usableDecision(prepared,[...data.films,{...data.films[0],id:'tmdb:3'}],data.seen,data.options),null);
 assert.equal(usableDecision({...prepared,candidates:prepared.candidates.slice(1)},data.films,data.seen,data.options),null);
 assert.equal(usableDecision({...prepared,references:[{...prepared.references[0],text:'A different actual passage.'}]},data.films,data.seen,data.options),null);
 process.env.OPENAI_SELECT_MODEL='a-different-critical-model';assert.equal(usableDecision(prepared,data.films,data.seen,data.options),null);
});

test('unknown output identities are filtered and empty or invalid decision caches cannot bypass critical selection',async t=>{
 isolate(t);const data=fixture();globalThis.fetch=async(input,init)=>{const value=request(input,init),normal=response(value);return output({...normal,ranking:['invented','c2','c2','c0'],recommendations:[{candidate:'invented',anchors:['a0'],why:'This invented candidate must never reach a reusable plan.',evidence:[]},...normal.recommendations.slice(0,2)],rejected:['invented','c11','c11']});};
 const result=await criticalPlan(data.preparation,data.films,data.seen,data.options,new AbortController().signal);assert.deepEqual(result.decision.ranking.slice(0,3),['c2','c0','c1']);assert.equal(result.decision.ranking.length,12);assert.deepEqual(result.decision.rejected,['c11']);assert.deepEqual(result.decision.recommendations.map(row=>row.candidate),['c0','c1']);
 const prepared={...data.preparation,decision:result.decision};
 assert.equal(usableDecision({...prepared,decision:{...result.decision,recommendations:[]}},data.films,data.seen,data.options),null);
 assert.equal(usableDecision({...prepared,decision:{...result.decision,ranking:['invented']}},data.films,data.seen,data.options),null);
 assert.equal(usableDecision({...prepared,decision:{...result.decision,recommendations:[{...result.decision.recommendations[0],anchors:['invented-anchor']}]}},data.films,data.seen,data.options),null);
});

test('critical preparation propagates provider or empty-plan failures instead of caching a fallback as completed work',async t=>{
 isolate(t);const data=fixture();let calls=0;
 globalThis.fetch=async(input,init)=>{request(input,init);calls++;return calls===1?Response.json({error:{code:'server_error'}},{status:502}):output({ranking:['c0'],recommendations:[],rejected:[]});};
 await assert.rejects(criticalPlan(data.preparation,data.films,data.seen,data.options,new AbortController().signal),error=>error instanceof AppError&&error.code==='RESEARCH_ERROR');
 await assert.rejects(criticalPlan(data.preparation,data.films,data.seen,data.options,new AbortController().signal),error=>error instanceof AppError&&error.code==='INVALID_RESEARCH');
 const caller=new AbortController();caller.abort();await assert.rejects(criticalPlan(data.preparation,data.films,data.seen,data.options,caller.signal),{name:'AbortError'});assert.equal(calls,2);
});
