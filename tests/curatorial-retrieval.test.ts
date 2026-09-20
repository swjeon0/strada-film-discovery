import test from 'node:test';
import assert from 'node:assert/strict';
import type {Film} from '../lib/domain';
import {extractSourceHtml,type SourceDocument} from '../lib/server/grounding';
import {findCuratorialReferences,isCuratorialSourceRelevant,prioritizeCuratorialHits,queryRelevantExcerpt,responseUsage,selectCuratorialQueries,type CuratorialQuery} from '../lib/server/source-search';

const seed:Film={id:'test:oharu',title:'The Life of Oharu',year:1952,director:'Kenji Mizoguchi',poster:''};
const candidate:Film={id:'candidate:0',title:'Good Morning',year:1959,director:'Yasujiro Ozu',poster:''};
const lens:CuratorialQuery={query:'domestic ritual silence postwar cinema criticism',filmIds:[seed.id],purpose:'lens'};
const critical='Domestic ritual and silence shape the postwar cinema discussed here. The director uses framing and narrative repetition to reveal the tension between private feeling and social obligation. Cinematography gives ordinary spaces a patient, observing quality, while performance complicates the appearance of harmony. ';
const article=(title:string,text=critical.repeat(6))=>`<html><head><title>${title}</title><meta name="author" content="A Film Critic"></head><body><article><h1>${title}</h1><p>${text.slice(0,600)}</p><p>${text.slice(600)}</p></article></body></html>`;
const document=(url='https://www.filmcomment.com/curatorial-concept-test',text=critical.repeat(6)):SourceDocument=>({url,...extractSourceHtml(article('Domestic ritual and postwar silence',text))});

test('concept criticism is relevant without any seed title, but unrelated or unsigned unknown pages are not',()=>{
 const doc=document();assert.equal(isCuratorialSourceRelevant(doc,lens,[seed,candidate]),true);
 assert.equal(isCuratorialSourceRelevant(doc,{...lens,purpose:'anchor'},[seed,candidate]),false);
 assert.equal(isCuratorialSourceRelevant(doc,{...lens,query:'underwater coral ecology'},[seed,candidate]),false);
 const newPublication=document('https://another-film-journal.net/essays/ritual');
 assert.equal(isCuratorialSourceRelevant(newPublication,lens,[seed,candidate]),true);
 assert.equal(isCuratorialSourceRelevant({...newPublication,author:null},lens,[seed,candidate]),false);
 assert.equal(isCuratorialSourceRelevant({...newPublication,article:false},lens,[seed,candidate]),false);
 const candidateDocument=document(undefined,'Good Morning, directed by Yasujiro Ozu. '+critical.repeat(6));
 assert.equal(isCuratorialSourceRelevant(candidateDocument,{query:'Good Morning Ozu criticism',filmIds:[candidate.id],purpose:'candidate'},[seed,candidate]),true);
});

test('retrieval chooses relevant late paragraphs with their neighbors instead of the article opening',()=>{
 const opening=Array.from({length:18},(_,i)=>`Opening section ${i} considers unrelated production bookkeeping. `+'Administrative background. '.repeat(15));
 const before='This preceding paragraph establishes the neighborhood and its shared expectations.';
 const target=critical.repeat(2),after='The next paragraph explains how a repeated meal changes the meaning of silence.';
 const paragraphs=[...opening,before,target,after];
 const doc={...document(),paragraphs,text:paragraphs.join(' ')};
 const excerpt=queryRelevantExcerpt(doc,lens.query,[seed],1800);
 assert.ok(excerpt.includes(target.trim()));assert.ok(excerpt.includes(before));assert.ok(excerpt.includes(after));
 assert.equal(excerpt.includes('Opening section 0'),false);assert.ok(excerpt.length<=1800);
});

test('six proposed queries receive at most three calls with anchor, lens and candidate coverage',()=>{
 const queries:CuratorialQuery[]=[{query:'Oharu essay',filmIds:[seed.id],purpose:'anchor'},{query:'Oharu social class',filmIds:[seed.id],purpose:'anchor'},lens,{query:'another ritual inquiry',filmIds:[],purpose:'lens'},{query:'Good Morning essay',filmIds:[candidate.id],purpose:'candidate'},{query:'duplicate candidate inquiry',filmIds:[candidate.id],purpose:'candidate'}];
 const selected=selectCuratorialQueries(queries);assert.equal(selected.length,3);assert.deepEqual(selected.map(q=>q.purpose),['anchor','lens','candidate']);
});

test('actual article hits are tried before generic academic landing pages without inventing new URLs',()=>{
 const hits=[{url:'https://academic.oup.com/journals',title:'Journals'},{url:'https://link.springer.com/book/10.1007/example',title:'A book'},{url:'https://www.filmcomment.com/article/a-precise-reading',title:'A precise reading'},{url:'https://academic.oup.com/screen/article-abstract/60/1/1/1234',title:'An actual academic abstract'}];
 const ranked=prioritizeCuratorialHits(hits);
 assert.equal(ranked[0].url,hits[2].url);assert.equal(ranked[1].url,hits[3].url);
 assert.deepEqual([...ranked.map(hit=>hit.url)].sort(),hits.map(hit=>hit.url).sort());
});

test('blocked and unreadable early hits release capacity for readable later articles',async t=>{
 let searches=0,attempts=0;const logs:any[]=[];
 t.mock.method(console,'info',(...args:unknown[])=>{if(args[0]==='STRADA curatorial retrieval')logs.push(args[1]);});
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
  if(String(input)==='https://api.openai.com/v1/responses'){
   searches++;return Response.json({output:[{type:'web_search_call',action:{sources:Array.from({length:7},(_,i)=>({url:`https://www.filmcomment.com/blocked-then-readable-${i}`,title:'Domestic ritual'}))}}]});
  }
  const url=String(input);assert.match(url,/\/blocked-then-readable-/);attempts++;
  const index=Number(url.split('-').at(-1));
  if(index<2)return new Response('Forbidden',{status:403,headers:{'Content-Type':'text/html'}});
  if(index===2)return new Response('<article>Too short.</article>',{headers:{'Content-Type':'text/html'}});
  return new Response(article('Domestic ritual'),{headers:{'Content-Type':'text/html'}});
 });
 const output=await findCuratorialReferences([seed],[{...lens,query:lens.query+' blocked-first retry-capacity'}],{remaining:32},new AbortController().signal);
 assert.equal(searches,1);assert.equal(attempts,5);assert.equal(output.references.length,2);
 assert.ok(output.references.every(ref=>/-(?:3|4)$/.test(ref.source.url)));
 assert.equal(logs[0].attempted,5);assert.equal(logs[0].documentsRead,2);assert.equal(logs[0].relevant,2);assert.equal(logs[0].rejections.unreadable_or_blocked,3);
});

test('all blocked searches stop at five attempts per query and sixteen overall without extra searches',async t=>{
 let searches=0;const attempts:Record<string,number>={};const logs:any[]=[];
 t.mock.method(console,'info',(...args:unknown[])=>{if(args[0]==='STRADA curatorial retrieval')logs.push(args[1]);});
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input)==='https://api.openai.com/v1/responses'){
   searches++;const body=JSON.parse(String(init?.body)),query=JSON.parse(body.input[1].content);
   return Response.json({output:[{type:'web_search_call',action:{sources:Array.from({length:9},(_,i)=>({url:`https://www.filmcomment.com/attempt-cap-${query.purpose}-${i}`,title:query.purpose}))}}]});
  }
  const purpose=String(input).match(/attempt-cap-(anchor|lens|candidate)-/)?.[1];assert.ok(purpose);attempts[purpose]=(attempts[purpose]??0)+1;
  return new Response('Forbidden',{status:403});
 });
 const queries:CuratorialQuery[]=[{query:'Oharu blocked maximum attempts',filmIds:[seed.id],purpose:'anchor'},{...lens,query:'ritual silence blocked maximum attempts'},{query:'Good Morning blocked maximum attempts',filmIds:[candidate.id],purpose:'candidate'}];
 const output=await findCuratorialReferences([seed,candidate],queries,{remaining:32},new AbortController().signal);
 assert.equal(searches,3);assert.deepEqual(attempts,{anchor:5,lens:5,candidate:5});assert.ok(logs[0].attempted<=16);assert.equal(logs[0].documentsRead,0);assert.equal(logs[0].relevant,0);assert.equal(output.references.length,0);
});

test('curatorial retrieval bounds documents and searches, retaining genuine candidate IDs and title-free lens context',async t=>{
 let searches=0,reads=0;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);
  if(url==='https://api.openai.com/v1/responses'){
   searches++;const body=JSON.parse(String(init?.body));assert.equal(body.max_tool_calls,1);
   const data=JSON.parse(body.input[1].content),purpose=data.purpose;
   return Response.json({model:'gpt-4.1-mini',output:[{type:'web_search_call',action:{sources:Array.from({length:5},(_,i)=>({url:`https://www.filmcomment.com/bounded-${purpose}-${i}`,title:purpose}))}}],usage:{input_tokens:100,output_tokens:50}});
  }
  assert.match(url,/^https:\/\/www\.filmcomment\.com\/bounded-/);reads++;
  const title=url.includes('anchor')?'The Life of Oharu':url.includes('candidate')?'Good Morning':'Domestic ritual';
  return new Response(article(title),{headers:{'Content-Type':'text/html'}});
 });
 const queries:CuratorialQuery[]=[{query:'Oharu Mizoguchi criticism',filmIds:[seed.id],purpose:'anchor'},lens,{query:'Good Morning Ozu criticism',filmIds:[candidate.id],purpose:'candidate'}];
 const result=await findCuratorialReferences([seed,candidate],queries,{remaining:50},new AbortController().signal);
 assert.equal(searches,3);assert.equal(reads,8);assert.equal(result.references.length,8);
 assert.ok(result.references.some(ref=>ref.purpose==='lens'&&ref.anchorIds.length===0));
 assert.ok(result.references.some(ref=>ref.purpose==='candidate'&&ref.anchorIds.includes('candidate:0')&&!ref.anchorIds.includes(seed.id)));
 assert.equal(result.usage.searchCalls,3);
});

test('a canceled stage retains completed verified articles and stops waiting on another query',async t=>{
 const controller=new AbortController();let pendingSignal:AbortSignal|undefined;
 t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input)==='https://api.openai.com/v1/responses'){
   const body=JSON.parse(String(init?.body)),question=JSON.parse(body.input[1].content);
   if(question.purpose==='candidate')return new Promise<Response>((_,reject)=>{pendingSignal=init?.signal??undefined;pendingSignal?.addEventListener('abort',()=>reject(pendingSignal?.reason),{once:true});});
   return Response.json({output:[{type:'web_search_call',action:{sources:[{url:'https://www.filmcomment.com/accumulated-before-cancel',title:'Domestic ritual'}]}}]});
  }
  setTimeout(()=>controller.abort(),10);
  return new Response(article('Domestic ritual'),{headers:{'Content-Type':'text/html'}});
 });
 const result=await findCuratorialReferences([seed,candidate],[{...lens,query:lens.query+' accumulated'}, {query:'Good Morning cancellation test criticism',filmIds:[candidate.id],purpose:'candidate'}],{remaining:8},controller.signal);
 assert.equal(result.references.length,1);assert.equal(pendingSignal?.aborted,true);
});

test('usage estimates apply the selected model and cached input prices without double counting a reported search block',()=>{
 const mini=responseUsage({model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:400}}},'gpt-5.4-mini');
 assert.equal(mini.cachedInputTokens,400);assert.ok(Math.abs(mini.estimatedUsd-.00093)<1e-10);
 const flagship=responseUsage({model:'gpt-5.4-2026-03-05',usage:{input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:400}}},'gpt-5.4');
 assert.ok(Math.abs(flagship.estimatedUsd-.0031)<1e-10);
 const output=[{type:'web_search_call'}];
 const small=responseUsage({usage:{input_tokens:100,output_tokens:0},output},'gpt-4.1-mini');
 assert.equal(small.estimatedSearchContentTokens,8000);assert.ok(Math.abs(small.estimatedUsd-.01324)<1e-10);
 const included=responseUsage({usage:{input_tokens:8100,output_tokens:0},output},'gpt-4.1-mini');
 assert.equal(included.estimatedSearchContentTokens,0);assert.equal(included.estimatedUsd,small.estimatedUsd);
});
