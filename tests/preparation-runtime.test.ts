import test from 'node:test';
import assert from 'node:assert/strict';
import {type Film,type ResearchOptions} from '../lib/domain';
import {prepareResearch,eligiblePreparedCandidates,preparationFingerprint} from '../lib/server/preparation';
import {readPreparationToken} from '../lib/server/preparation-token';
import {research} from '../lib/server/research';

type ModelInput={language:string;selected:{code:string;id:string;title:string}[];requestedCandidateCount?:number;retainedCandidates?:{code:string;title:string;lens:string}[];retainedLenses?:{id:string;question:string}[];references?:{code:string;excerpt:string}[];verifiedCandidates?:{code:string;title:string}[]};
const PASSAGE='The extended shot turns framing into a record of changing attention, rather than a container for plot.';
const signal=()=>new AbortController().signal;
const ids=(films:Film[])=>films.map(film=>film.id);
const options=(preparationToken?:string,intent:ResearchOptions['intent']='initial',previousIds:string[]=[],language:ResearchOptions['language']='en'):ResearchOptions=>({intent,previousIds,language,...preparationToken?{preparationToken}:{}});
const modelResponse=(value:unknown)=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:100,output_tokens:80}});
let sequence=0;
function setup(t:{after:(callback:()=>void)=>void},name:string,holdDraft=false,scenario:{missingIndices?:number[];topUpDuplicates?:boolean}={}){
 const base=930000+(++sequence)*100,environment=['OPENAI_API_KEY','TMDB_READ_ACCESS_TOKEN','OPENAI_CURATOR_MODEL','OPENAI_DRAFT_MODEL','OPENAI_SELECT_MODEL','OPENAI_WRITE_MODEL','OPENAI_DETAIL_MODEL','OPENAI_SEARCH_MODEL'] as const;
 const old=Object.fromEntries(environment.map(key=>[key,process.env[key]])),oldFetch=globalThis.fetch;
 Object.assign(process.env,{OPENAI_API_KEY:'preparation-runtime-fixture-key-no-network',TMDB_READ_ACCESS_TOKEN:'fixture-tmdb-token',OPENAI_CURATOR_MODEL:`fixture-curator-${name}`,OPENAI_DRAFT_MODEL:`fixture-draft-${name}`,OPENAI_SELECT_MODEL:`fixture-select-${name}`,OPENAI_WRITE_MODEL:`fixture-write-${name}`,OPENAI_DETAIL_MODEL:`fixture-detail-${name}`,OPENAI_SEARCH_MODEL:`fixture-search-${name}`});
 const films:Film[]=Array.from({length:45},(_,i)=>({id:`tmdb:${base+i}`,title:`Preparation ${name} Film ${i}`,titleKo:`준비 영화 ${sequence}-${i}`,year:1950+i,director:`Preparation Director ${i}`,poster:`https://image.tmdb.org/t/p/w500/preparation-${base+i}.jpg`}));
 const selected=films.slice(40,42),calls={draft:0,curate:0,write:0,search:0,anchorSearch:0,metadata:0,article:0},events:string[]=[],inputs:{stage:'draft'|'curate';value:ModelInput}[]=[],draftSizes:number[]=[];
 const articleTitles=new Map<string,string>(),unexpected:string[]=[];
 let releaseDraft:()=>void=()=>{throw new Error('The draft has not started.');};
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url==='https://api.openai.com/v1/responses'){
   const body=JSON.parse(String(init?.body)) as {text?:{format?:{name?:string;schema?:{properties:{candidates?:{minItems:number;maxItems:number}}}}};input:{role:string;content:string}[]},stage=body.text?.format?.name;
   const request=JSON.parse(body.input.find(row=>row.role==='user')!.content);
   if(stage?.startsWith('strada_draft_')){
    const data=request as ModelInput;calls.draft++;events.push('draft-start');inputs.push({stage:'draft',value:data});
    const count=data.requestedCandidateCount??24,draftSchema=body.text?.format?.schema?.properties.candidates;assert.ok(draftSchema);assert.equal(draftSchema.minItems,count);assert.equal(draftSchema.maxItems,count);draftSizes.push(count);
    const proposed=count===12?(scenario.topUpDuplicates?[films[13],films[13],...films.slice(24,34)]:films.slice(24,36)):films.slice(0,24);
    const anchors=data.selected.map(film=>film.code),draft={lenses:[{id:'l1',label:'Duration and framing',question:count===12?'An unnecessary rewritten lens question.':'How do duration and framing differently organize attention?',anchors},{id:'l2',label:'Sound and historical space',question:'How does offscreen sound articulate a social space?',anchors}],candidates:proposed.map((film,i)=>({title:film.title,year:film.year,director:film.director,lens:i%2?'l2':'l1',anchors,bridge:'Its framing and duration transform the viewing problem of the selected films.'})),queries:[{query:`Selected film formal criticism ${name}`,anchors,purpose:'anchor'},{query:`Duration framing cinema historical space ${name}`,anchors:[],purpose:'lens'}]};
    if(holdDraft&&calls.draft===1)return new Promise<Response>((resolve,reject)=>{releaseDraft=()=>{events.push('draft-complete');resolve(modelResponse(draft));};init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true});});
    events.push('draft-complete');return modelResponse(draft);
   }
   if(stage?.startsWith('strada_curate_')){
    const data=request as ModelInput;calls.curate++;inputs.push({stage:'curate',value:data});assert.ok(data.verifiedCandidates);
    return modelResponse({readings:[],ranking:data.verifiedCandidates.map(row=>row.code),recommendations:data.verifiedCandidates.slice(0,12).map(row=>({candidate:row.code,anchors:data.selected.map(film=>film.code),why:`${row.title} develops a precise relationship between the selected films' duration and framing while changing the role of sound.`,evidence:[]})),rejected:[]});
   }
   if(stage?.startsWith('strada_write_')){
    calls.write++;const data=request as {approvedConnections:{candidate:string;decision:string}[]};
    return modelResponse({recommendations:data.approvedConnections.map(row=>({candidate:row.candidate,why:row.decision+' The distinct use of offscreen sound keeps the comparison specific to these films.'}))});
   }
   if(!stage){
    const data=request as {purpose:string;films:{title:string}[]};calls.search++;if(data.purpose==='anchor'){calls.anchorSearch++;events.push('anchor-search-start');}
    const title=data.purpose==='anchor'?data.films[0].title:`Duration framing cinema ${name}`,articleUrl=`https://www.filmcomment.com/article/${encodeURIComponent(title)}`;articleTitles.set(articleUrl,title);
    return Response.json({output:[{type:'web_search_call',action:{sources:[{url:articleUrl,title}]}}],usage:{input_tokens:30,output_tokens:20}});
   }
  }
  const title=articleTitles.get(url);
  if(title){
   calls.article++;const html=`<html><head><title>${title}</title><meta name="author" content="A Film Critic"></head><body><article><h1>${title}</h1><p>${PASSAGE}</p><p>${'The director uses duration and framing to organize attention in cinema. This film criticism relates offscreen sound to historical space and social conditions, while keeping a formal claim distinct from a speculative association. '.repeat(5)}</p></article></body></html>`;
   return new Response(html,{headers:{'content-type':'text/html'}});
  }
  if(url.startsWith('https://api.themoviedb.org/3/')){
   calls.metadata++;const parsed=new URL(url);
   if(parsed.pathname==='/3/search/movie'){
    const film=films.find(film=>film.title===parsed.searchParams.get('query'));assert.ok(film,`Unexpected metadata search: ${parsed.searchParams.get('query')}`);
    if(scenario.missingIndices?.includes(films.indexOf(film)))return Response.json({results:[]});
    return Response.json({results:[{id:Number(film.id.slice(5)),title:film.title,release_date:`${film.year}-01-01`,poster_path:`/preparation-${film.id.slice(5)}.jpg`}]});
   }
   const match=/^\/3\/movie\/(\d+)$/.exec(parsed.pathname);
   if(match){const film=films.find(film=>film.id===`tmdb:${match[1]}`);assert.ok(film);return Response.json({id:Number(match[1]),title:film.title,original_title:film.title,release_date:`${film.year}-01-01`,poster_path:`/preparation-${match[1]}.jpg`,overview:'A verified database synopsis.',credits:{crew:[{job:'Director',name:film.director}]},translations:{translations:[{iso_639_1:'ko',data:{title:film.titleKo,overview:'검증된 데이터베이스 줄거리.'}}]},genres:[],production_countries:[]});}
  }
  unexpected.push(url);throw new Error('Unexpected external request blocked by preparation test.');
 };
 t.after(()=>{globalThis.fetch=oldFetch;for(const key of environment){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}assert.deepEqual(unexpected,[]);});
 return {selected,films,calls,events,inputs,draftSizes,releaseDraft:()=>releaseDraft()};
}

test('selected-film source searches begin while the candidate draft is still running',async t=>{
 const fixture=setup(t,'parallel-start',true),pending=prepareResearch(ids(fixture.selected),[],signal(),[],[],options());
 for(let i=0;i<80&&(fixture.calls.anchorSearch<2||fixture.calls.draft<1);i++)await new Promise(resolve=>setImmediate(resolve));
 const beforeRelease={anchors:fixture.calls.anchorSearch,drafts:fixture.calls.draft,events:[...fixture.events]};fixture.releaseDraft();
 const result=await pending;assert.equal(beforeRelease.anchors,2);assert.equal(beforeRelease.drafts,1);assert.equal(beforeRelease.events.includes('draft-complete'),false);
 assert.deepEqual(result.preparation.coveredFilmIds,ids(fixture.selected));assert.equal(result.preparation.candidates.length,24);assert.ok(result.preparationToken);
 assert.ok(result.preparation.references.some(reference=>reference.text.includes(PASSAGE)));assert.equal(fixture.calls.curate,0);
});

test('cached selected-film passages inform a new draft immediately while source research is reused',async t=>{
 const fixture=setup(t,'cached-draft-context');await prepareResearch(ids(fixture.selected),[],signal(),[],[],options());
 const searches=fixture.calls.anchorSearch;
 await prepareResearch(ids(fixture.selected),[],signal(),[],[],options(undefined,'initial',[],'ko'));
 assert.equal(fixture.calls.draft,2);assert.equal(fixture.calls.anchorSearch,searches);
 const latest=fixture.inputs.filter(row=>row.stage==='draft').at(-1);assert.ok(latest);
 assert.ok(JSON.stringify(latest.value).includes(PASSAGE),'A new draft should receive already-read selected-film passages, not only metadata.');
});

test('a warm preparation token skips drafting and searching, while regeneration reuses only eligible unseen candidates',async t=>{
 const fixture=setup(t,'reuse-pool'),prepared=await prepareResearch(ids(fixture.selected),[],signal(),[],[],options());assert.ok(prepared.preparationToken);
 const before={...fixture.calls},firstSeen=ids(fixture.films.slice(0,12)),regenerate=options(prepared.preparationToken,'regenerate',firstSeen);
 const reused=await prepareResearch(ids(fixture.selected),[],signal(),firstSeen,fixture.films.slice(0,12),regenerate);
 assert.equal(reused.timings.preparationReused,true);assert.equal(reused.usage.searchCalls,0);assert.equal(reused.usage.estimatedUsd,0);
 assert.equal(reused.timings.draftMs,0);assert.equal(reused.timings.anchorResearchMs,0);assert.equal(reused.timings.candidateResolutionMs,0);assert.equal(reused.timings.focusedResearchMs,0);
 assert.equal(fixture.calls.draft,before.draft);assert.equal(fixture.calls.search,before.search);
 assert.deepEqual(eligiblePreparedCandidates(reused.preparation,firstSeen,regenerate).map(row=>row.film.id),ids(fixture.films.slice(12,24)));
 const result=await research(ids(fixture.selected),[],signal(),firstSeen,fixture.films.slice(0,12),regenerate);
 assert.equal(fixture.calls.draft,before.draft);assert.equal(fixture.calls.search,before.search);assert.equal(fixture.calls.curate,1);
 assert.deepEqual(result.batch.recommendations.map(rec=>rec.film.id),ids(fixture.films.slice(12,24)));
 assert.ok(result.batch.recommendations.every(rec=>!firstSeen.includes(rec.film.id)));
});

test('the visible result retains its unused twelve-film reserve and regenerates without another draft or search',async t=>{
 const fixture=setup(t,'result-reserve'),first=await research(ids(fixture.selected),[],signal(),[],[],options());
 const shown=first.batch.recommendations.map(rec=>rec.film.id),token=first.batch.preparationToken;assert.ok(token);
 const reserve=readPreparationToken(token,fixture.selected,'en',preparationFingerprint());assert.ok(reserve);
 assert.deepEqual(reserve.candidates.map(row=>row.film.id),ids(fixture.films.slice(12,24)));
 assert.ok(reserve.candidates.every(row=>!shown.includes(row.film.id)));const before={...fixture.calls};
 const next=await research(ids(fixture.selected),[],signal(),shown,first.batch.recommendations.map(rec=>rec.film),options(token,'regenerate',shown));
 assert.equal(fixture.calls.draft,before.draft);assert.equal(fixture.calls.search,before.search);assert.equal(fixture.calls.curate,before.curate+1);
 assert.deepEqual(next.batch.recommendations.map(rec=>rec.film.id),ids(fixture.films.slice(12,24)));
});

test('language or draft configuration changes rebuild preparation; selection-only model changes retain the prepared pool',async t=>{
 const fixture=setup(t,'invalidation'),first=await prepareResearch(ids(fixture.selected),[],signal(),[],[],options());assert.ok(first.preparationToken);
 process.env.OPENAI_SELECT_MODEL='fixture-select-upgraded';
 const selectionOnly=await prepareResearch(ids(fixture.selected),[],signal(),[],[],options(first.preparationToken));assert.equal(selectionOnly.timings.preparationReused,true);assert.equal(fixture.calls.draft,1);
 const korean=await prepareResearch(ids(fixture.selected),[],signal(),[],[],options(first.preparationToken,'initial',[],'ko'));assert.equal(korean.timings.preparationReused,false);assert.equal(fixture.calls.draft,2);assert.equal(korean.preparation.language,'ko');
 process.env.OPENAI_DRAFT_MODEL='fixture-draft-upgraded';
 const changed=await prepareResearch(ids(fixture.selected),[],signal(),[],[],options(korean.preparationToken,'initial',[],'ko'));assert.equal(changed.timings.preparationReused,false);assert.equal(fixture.calls.draft,3);
 assert.notEqual(changed.preparation.fingerprint,korean.preparation.fingerprint);
});

test('a partial pool retains eleven eligible candidates and requests only twelve fresh additions',async t=>{
 const fixture=setup(t,'exhausted-pool'),first=await prepareResearch(ids(fixture.selected),[],signal(),[],[],options());assert.ok(first.preparationToken);
 const seen=ids(fixture.films.slice(0,13));
 const refreshed=await prepareResearch(ids(fixture.selected),[],signal(),seen,fixture.films.slice(0,13),options(first.preparationToken,'regenerate',seen.slice(1)));
 assert.equal(refreshed.timings.preparationReused,false);assert.equal(fixture.calls.draft,2);
 assert.deepEqual(refreshed.preparation.candidates.map(row=>row.film.id),[...ids(fixture.films.slice(13,24)),...ids(fixture.films.slice(24,36))]);
 assert.ok(refreshed.preparation.candidates.every(row=>!seen.includes(row.film.id)));
 assert.deepEqual(fixture.draftSizes,[24,12]);
 const topUp=fixture.inputs.filter(row=>row.stage==='draft').at(-1)!.value;assert.equal(topUp.retainedCandidates?.length,11);assert.ok(topUp.retainedLenses?.length);
 assert.equal(new Set(refreshed.preparation.candidates.map(row=>row.code)).size,23);
 assert.deepEqual(refreshed.preparation.candidates.slice(0,11),JSON.parse(JSON.stringify(first.preparation.candidates.slice(13,24))));
 assert.deepEqual(refreshed.preparation.lenses,first.preparation.lenses,'A top-up cannot silently change the meaning of retained lens IDs.');
 assert.ok(first.preparation.references.every(ref=>refreshed.preparation.references.some(next=>next.source.url===ref.source.url&&next.text.includes(PASSAGE))));
});

test('a real-sized twenty-two-candidate preparation keeps its ten-film reserve and tops it up on regeneration',async t=>{
 const fixture=setup(t,'twenty-two-reserve',false,{missingIndices:[22,23]}),first=await research(ids(fixture.selected),[],signal(),[],[],options());
 assert.equal(first.batch.reserveCount,10);assert.ok(first.batch.preparationToken);const shown=first.batch.recommendations.map(rec=>rec.film.id);
 const next=await research(ids(fixture.selected),[],signal(),shown,first.batch.recommendations.map(rec=>rec.film),options(first.batch.preparationToken,'regenerate',shown));
 assert.deepEqual(fixture.draftSizes,[24,12]);assert.equal(next.batch.recommendations.length,12);
 assert.deepEqual(next.batch.recommendations.slice(0,10).map(rec=>rec.film.id),ids(fixture.films.slice(12,22)));
 assert.ok(next.batch.recommendations.every(rec=>!shown.includes(rec.film.id)));assert.equal(next.batch.reserveCount,10);
});

test('duplicate top-up proposals cannot duplicate a retained film or discard the existing reserve',async t=>{
 const fixture=setup(t,'top-up-dedupe',false,{topUpDuplicates:true}),first=await prepareResearch(ids(fixture.selected),[],signal(),[],[],options());
 const seen=ids(fixture.films.slice(0,13)),next=await prepareResearch(ids(fixture.selected),[],signal(),seen,fixture.films.slice(0,13),options(first.preparationToken,'regenerate',seen));
 assert.deepEqual(fixture.draftSizes,[24,12]);assert.equal(next.preparation.candidates.length,21);
 assert.equal(new Set(next.preparation.candidates.map(row=>row.film.id)).size,21);
 assert.deepEqual(next.preparation.candidates.slice(0,11),JSON.parse(JSON.stringify(first.preparation.candidates.slice(13,24))));
});

test('following a new film inherits prior references but rebuilds candidate arguments for the changed selection',async t=>{
 const fixture=setup(t,'cross-step-readings'),first=await prepareResearch(ids(fixture.selected),[],signal(),[],[],options());
 const added=fixture.films[42],next=await prepareResearch(ids(fixture.selected),[added.id],signal(),[],[],options(first.preparationToken,'manual'));
 assert.deepEqual(fixture.draftSizes,[24,24]);assert.equal(fixture.calls.anchorSearch,3);
 const draft=fixture.inputs.filter(row=>row.stage==='draft').at(-1)!.value;assert.equal(draft.selected.length,3);assert.equal(draft.retainedCandidates,undefined);
 assert.ok(JSON.stringify(draft).includes(PASSAGE));assert.deepEqual(next.preparation.coveredFilmIds,[...ids(fixture.selected),added.id]);
 assert.ok(first.preparation.references.every(ref=>next.preparation.references.some(value=>value.source.url===ref.source.url)));
});
