import test from 'node:test';
import assert from 'node:assert/strict';
import {RecommendationSchema,type Film,type ResearchOptions} from '../lib/domain';
import {research} from '../lib/server/research';
import {POST} from '../app/api/recommendations/route';
import {filmById} from '../lib/catalogue';

type TestContext={after:(fn:()=>void)=>void};
type ModelBody={text?:{format?:{name?:string}},input:{role:string,content:string}[]};
type Scenario={sources?:'fail'|'actual';final?:'normal'|'mixed-evidence'|'false-evidence'|'fail';aliases?:Film[];blockDraft?:(signal:AbortSignal)=>Promise<Response>};
const PASSAGE='Close-Up makes the staging of testimony part of how spectators evaluate the account.';
let scenarioNumber=0;

function output(value:unknown){return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:120,output_tokens:90}});}
function setup(t:TestContext,name:string,scenario:Scenario={}){
 const number=++scenarioNumber,base=700000+number*100;
 const environment=['OPENAI_API_KEY','OPENAI_CURATOR_MODEL','OPENAI_SEARCH_MODEL','TMDB_READ_ACCESS_TOKEN','PUBLIC_MODE','VERCEL'] as const;
 const previous=Object.fromEntries(environment.map(key=>[key,process.env[key]]));
 process.env.OPENAI_API_KEY='test-key-never-sent';process.env.OPENAI_CURATOR_MODEL=`test-curator-${name}`;process.env.OPENAI_SEARCH_MODEL=`test-search-${name}`;process.env.TMDB_READ_ACCESS_TOKEN='test-tmdb-token-never-sent';process.env.PUBLIC_MODE='false';process.env.VERCEL='0';
 const films:Film[]=Array.from({length:50},(_,i)=>({id:`tmdb:${base+i}`,title:`Fixture ${name} Film ${i}`,titleKo:`검증 영화 ${number}-${i}`,year:1950+i,director:`Fixture Director ${i}`,poster:`https://image.tmdb.org/t/p/w500/fixture-${base+i}.jpg`}));
 const articleUrl=`https://www.criterion.com/current/posts/${base}-fixture-${name}`;
 const calls={draft:0,curate:0,search:0,article:0,metadata:0};
 const modelInputs:{stage:string;input:any}[]=[];
 const unexpected:string[]=[];
 const originalFetch=globalThis.fetch;
 const article=`<html><head><title>Close-Up, materiality and duration in cinema</title><meta name="author" content="Fixture Critic"></head><body><article><p>${PASSAGE}</p><p>${'This fixture criticism considers duration, testimony and cinematic form. Its account of framing and performance remains distinct from the curator’s cross-film proposal. '.repeat(5)}</p></article></body></html>`;
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url==='https://api.openai.com/v1/responses'){
   const body=JSON.parse(String(init?.body)) as ModelBody;
   const stage=body.text?.format?.name;
   if(stage?.startsWith('strada_draft_')){
    calls.draft++;const request=JSON.parse(body.input.find(row=>row.role==='user')!.content);modelInputs.push({stage:'draft',input:request});
    if(scenario.blockDraft)return scenario.blockDraft(init!.signal!);
    const anchors=request.selected.map((film:{code:string})=>film.code);
    return output({lenses:[{id:'l1',label:'Duration and testimony',question:'How does duration change the status of testimony?',anchors},{id:'l2',label:'Performance and framing',question:'What does framing make visible in a performance?',anchors}],candidates:films.slice(0,24).map((film,i)=>({title:film.title,year:film.year,director:film.director,lens:i%2?'l2':'l1',anchors:anchors.slice(0,4),bridge:`${film.title} offers a specific provisional relation through duration.`,contrast:'Its different framing introduces another viewing question.',check:'Check the proposed account of cinematic form.'})),queries:[{query:`Close-Up duration testimony criticism ${name}`,anchors,purpose:'anchor'},{query:`Materiality duration cinematic form ${name}`,anchors:[],purpose:'lens'}]});
   }
   if(stage?.startsWith('strada_curate_')){
    calls.curate++;const request=JSON.parse(body.input.find(row=>row.role==='user')!.content);modelInputs.push({stage:'curate',input:request});
    if(scenario.final==='fail')return new Response('',{status:502});
    const reference=request.references[0]?.code;
    return output({ranking:request.verifiedCandidates.map((row:{code:string})=>row.code),recommendations:request.verifiedCandidates.slice(0,12).map((row:{code:string,title:string},i:number)=>{
     let evidence:unknown[]=[];
     if(reference&&scenario.final==='mixed-evidence'){
      if(i===0)evidence=[{ref:reference,passage:PASSAGE,point:'The passage supports a reading of testimony in Close-Up, while the comparison is STRADA’s proposal.'}];
      if(i===1)evidence=[{ref:reference,passage:'An invented comparison never present in the supplied article.',point:'A claim with no actual supporting passage.'}];
      if(i===2)evidence=[{ref:'invented-source',passage:PASSAGE,point:'An invented source identity.'}];
     }
     if(reference&&scenario.final==='false-evidence')evidence=[{ref:reference,passage:'An invented exact quotation which is absent from every supplied passage.',point:'This must never become a sourced connection.'}];
     return {candidate:row.code,lens:'Duration and testimony',anchors:request.selected.map((film:{code:string})=>film.code).slice(0,4),why:`${row.title} extends the selected films through a specific relationship between duration and performance.`,bridge:'An explicit formal relationship.',contrast:'A distinct question for the next viewing.',evidence};
    }),rejected:[]});
   }
   if(stage?.startsWith('strada_write_')){
    const request=JSON.parse(body.input.find(row=>row.role==='user')!.content);
    return output({recommendations:request.approvedConnections.map((row:{candidate:string;decision:string})=>({candidate:row.candidate,why:row.decision}))});
   }
   if(!stage){
    calls.search++;
    if(scenario.sources!=='actual')return new Response('',{status:503});
    return Response.json({status:'completed',output:[{type:'web_search_call',action:{sources:[{url:articleUrl,title:'Fixture criticism'}]}}],usage:{input_tokens:20,output_tokens:10}});
   }
  }
  if(url===articleUrl){calls.article++;return new Response(article,{headers:{'content-type':'text/html'}});}
  if(url.startsWith('https://api.themoviedb.org/3/')){
   calls.metadata++;const parsed=new URL(url);
   if(parsed.pathname==='/3/search/movie'){
    const film=films.find(film=>film.title===parsed.searchParams.get('query'));
    assert.ok(film,`Unexpected film lookup: ${parsed.searchParams.get('query')}`);
    return Response.json({results:[{id:Number(film.id.slice(5)),title:film.title,release_date:`${film.year}-01-01`,poster_path:`/fixture-${film.id.slice(5)}.jpg`}]});
   }
   const match=/^\/3\/movie\/(\d+)$/.exec(parsed.pathname);
   if(match){const film=[...films,...scenario.aliases??[]].find(film=>film.id===`tmdb:${match[1]}`);assert.ok(film,`Unexpected detail lookup ${match[1]}`);return Response.json({id:Number(match[1]),title:film.title,original_title:film.title,original_language:'en',release_date:`${film.year}-01-01`,poster_path:`/fixture-${match[1]}.jpg`,overview:'A database synopsis supplied by the fixture.',credits:{crew:[{job:'Director',name:film.director}]},translations:{translations:[{iso_639_1:'ko',data:{title:film.titleKo,overview:'데이터베이스 줄거리입니다.'}}]},genres:[],production_countries:[]});}
  }
  unexpected.push(url);throw new Error(`Unexpected external request blocked: ${url}`);
 };
 t.after(()=>{globalThis.fetch=originalFetch;for(const key of environment){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}assert.deepEqual(unexpected,[],'Every request must be handled by an explicit fixture.');});
 return {films,calls,modelInputs,articleUrl};
}
const options=(intent:ResearchOptions['intent']='initial',previousIds:string[]=[]):ResearchOptions=>({intent,previousIds,language:'ko'});
const ids=(films:Film[])=>films.map(film=>film.id);
const resultIds=(result:Awaited<ReturnType<typeof research>>)=>result.batch.recommendations.map(rec=>rec.film.id);
const signal=()=>new AbortController().signal;

test('failed live source searches still produce 12 verified AI recommendations with current-language curation',async t=>{
 const fixture=setup(t,'source-failure');
 const result=await research(['closeup'],[],signal(),[],[],options());
 assert.equal(result.batch.recommendations.length,12);
 assert.equal(new Set(resultIds(result)).size,12);
 assert.deepEqual(result.batch.sources,[]);
 assert.ok(result.batch.recommendations.every(rec=>RecommendationSchema.safeParse(rec).success&&rec.connections.every(connection=>connection.relation==='ai_inference'&&connection.whyKo===connection.why)&&!!rec.curation&&!!rec.detailToken));
 assert.deepEqual(resultIds(result),ids(fixture.films.slice(0,12)));
 // One selected-film search plus a draft lens query and a reviewed-corpus
 // operation query; failures still fall back to honest AI curation.
 assert.equal(fixture.calls.draft,1);assert.equal(fixture.calls.curate,1);assert.equal(fixture.calls.search,3);
 assert.equal(fixture.modelInputs[0].input.language,'ko');
 assert.deepEqual(fixture.modelInputs[0].input.selected.map((film:{id:string})=>film.id),['closeup']);
});

test('only exact fetched passages and real reference codes become sourced connections',async t=>{
 const fixture=setup(t,'grounded-passages',{sources:'actual',final:'mixed-evidence'});
 const result=await research(['closeup'],[],signal(),[],[],options());
 assert.equal(result.batch.recommendations.length,12);
 assert.equal(result.batch.sources.length,1);
 assert.equal(result.batch.sources[0].url,fixture.articleUrl);
 assert.equal(result.batch.sources[0].excerpt,PASSAGE);
 assert.equal(result.batch.sources[0].scope,'interpretive_context');
 assert.equal(result.batch.recommendations[0].connections[0].relation,'grounded_interpretation');
 assert.deepEqual(result.batch.recommendations[0].sourceIds,[result.batch.sources[0].id]);
 assert.ok(result.batch.recommendations.slice(1).every(rec=>rec.sourceIds.length===0&&rec.connections.every(connection=>connection.relation==='ai_inference')));
 assert.ok(result.batch.recommendations.every(rec=>RecommendationSchema.safeParse(rec).success));
 assert.ok(fixture.calls.article>=1);
});

test('readable sources do not become evidence when every offered quotation is fabricated',async t=>{
 setup(t,'false-passages',{sources:'actual',final:'false-evidence'});
 const result=await research(['closeup'],[],signal(),[],[],options());
 assert.equal(result.batch.recommendations.length,12);
 assert.deepEqual(result.batch.sources,[]);
 assert.ok(result.batch.recommendations.every(rec=>rec.sourceIds.length===0&&rec.contextScope==='discovery'));
});

test('failed final curation preserves verified draft candidates with honest source-free fallback explanations',async t=>{
 const fixture=setup(t,'curation-fallback',{sources:'actual',final:'fail'});
 const result=await research(['closeup'],[],signal(),[],[],options());
 assert.deepEqual(resultIds(result),ids(fixture.films.slice(0,12)));
 assert.deepEqual(result.batch.sources,[]);
 assert.ok(result.batch.recommendations.every(rec=>rec.connections[0].why.includes('provisional relation')&&rec.connections[0].why.includes('different framing')));
 const cached=await research(['closeup'],[],signal(),[],[],options());
 assert.equal(cached.usage.cached,true);assert.equal(fixture.calls.draft,1);assert.equal(fixture.calls.curate,1);
});

test('regeneration excludes the entire active history and a changed exclusion set cannot reuse its cached batch',async t=>{
 const fixture=setup(t,'regenerate');
 const seen=ids(fixture.films.slice(0,8)),discovered=fixture.films.slice(8,12),previous=ids(fixture.films.slice(6,12));
 const first=await research(['closeup'],[],signal(),seen,discovered,options('regenerate',previous));
 assert.deepEqual(resultIds(first),ids(fixture.films.slice(12,24)));
 const cached=await research(['closeup'],[],signal(),[...seen].reverse(),[...discovered].reverse(),options('regenerate',[...previous].reverse()));
 assert.equal(cached.usage.cached,true);assert.equal(fixture.calls.draft,1);
 const next=await research(['closeup'],[],signal(),[...seen,fixture.films[12].id],discovered,options('regenerate',previous));
 assert.equal(next.usage.cached,undefined);assert.equal(fixture.calls.draft,2);
 assert.deepEqual(resultIds(next),ids(fixture.films.slice(13,24)));
 assert.equal(next.batch.notice,'partial');
 assert.ok(fixture.modelInputs.filter(row=>row.stage==='draft').every(row=>row.input.selected.length===1&&row.input.selected[0].id==='closeup'));
});

for(const intent of ['follow','manual'] as const){
 test(`${intent} filters a repeat-heavy curator order to at least seven fresh films`,async t=>{
  const fixture=setup(t,`${intent}-freshness`),previous=ids(fixture.films.slice(0,12));
  const result=await research(['closeup'],[fixture.films[40].id],signal(),previous,fixture.films.slice(0,12),options(intent,previous));
  assert.deepEqual(resultIds(result),[...ids(fixture.films.slice(0,5)),...ids(fixture.films.slice(12,19))]);
  assert.equal(resultIds(result).filter(id=>previous.includes(id)).length,5);
  assert.ok(fixture.modelInputs[0].input.selected.every((film:{weight:number})=>film.weight===.5));
  assert.equal(fixture.modelInputs[0].input.selected.length,2);
 });
}

test('shared cached selections retain the seed and trail order of each caller',async t=>{
 const fixture=setup(t,'ordered-cache');
 const first=await research(['closeup','fake'],['apple','boards'],signal(),[],[],options('manual'));
 const second=await research(['fake','closeup'],['boards','apple'],signal(),[],[],options('manual'));
 assert.equal(second.usage.cached,true);assert.equal(fixture.calls.draft,1);
 assert.deepEqual(first.seeds.map(film=>film.id),['closeup','fake']);
 assert.deepEqual(second.seeds.map(film=>film.id),['fake','closeup']);
 assert.deepEqual(second.trail.map(film=>film.id),['boards','apple']);
 assert.ok(fixture.modelInputs[0].input.selected.every((film:{weight:number})=>film.weight===.25));
});

test('TMDB aliases resolving to catalogue identities preserve seed and trail objects on fresh and reordered cache responses',async t=>{
 const fixture=setup(t,'canonical-aliases',{aliases:[{...filmById('closeup')!,id:'tmdb:30017'},{...filmById('fake')!,id:'tmdb:43003'}]});
 const first=await research(['tmdb:30017','apple'],['tmdb:43003','boards'],signal(),[],[],options('manual'));
 assert.deepEqual(first.seeds.map(film=>film?.id),['closeup','apple']);
 assert.deepEqual(first.trail.map(film=>film?.id),['fake','boards']);
 assert.ok([...first.seeds,...first.trail].every(film=>film?.title&&film?.director));
 const reordered=await research(['apple','tmdb:30017'],['boards','tmdb:43003'],signal(),[],[],options('manual'));
 assert.equal(reordered.usage.cached,true);assert.equal(fixture.calls.draft,1);
 assert.deepEqual(reordered.seeds.map(film=>film?.id),['apple','closeup']);
 assert.deepEqual(reordered.trail.map(film=>film?.id),['boards','fake']);
 assert.ok([...reordered.seeds,...reordered.trail].every(film=>film?.title&&film?.director));
 assert.deepEqual(resultIds(reordered),resultIds(first));
});

test('canceling one shared viewer preserves the job while canceling the last viewer aborts upstream',async t=>{
 let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});let upstreamAborted=false;
 const fixture=setup(t,'cancel',{blockDraft:async upstreamSignal=>new Promise<Response>((_,reject)=>{
  upstreamSignal.addEventListener('abort',()=>{upstreamAborted=true;reject(upstreamSignal.reason);},{once:true});started();
 })});
 const first=new AbortController(),second=new AbortController();
 const firstJob=research(['fake'],[],first.signal,[],[],options());
 const secondJob=research(['fake'],[],second.signal,[],[],options());
 const firstRejected=assert.rejects(firstJob,{name:'AbortError'}),secondRejected=assert.rejects(secondJob,{name:'AbortError'});
 await ready;first.abort();await firstRejected;
 assert.equal(upstreamAborted,false);assert.equal(fixture.calls.draft,1);
 second.abort();await secondRejected;
 assert.equal(upstreamAborted,true);
});


test('production discovery accepts more than the former daily and caller limits without a quota service',async t=>{
 const fixture=setup(t,'unlimited-discovery');
 process.env.PUBLIC_MODE='true';process.env.VERCEL='1';
 for(let i=0;i<60;i++){
  const request=new Request('https://strada.example.net/api/recommendations',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://strada.example.net','x-vercel-forwarded-for':'192.0.2.1'},body:JSON.stringify({requestId:`unlimited-${i}`,baseSnapshotId:null,seeds:['closeup'],trail:[],seenIds:[`tmdb:${9000000+i}`],language:'ko'})});
  const response=await POST(request);assert.equal(response.status,200);
  assert.equal((await response.json()).recommendations.length,12);
 }
 assert.equal(fixture.calls.draft,60);assert.equal(fixture.calls.curate,60);
});
