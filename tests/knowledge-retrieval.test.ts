import assert from 'node:assert/strict';
import test from 'node:test';
import type {Film} from '../lib/domain';
import {curatorDecisionBatch} from '../lib/server/curator-production';
import {issueDetailToken,readDetailToken} from '../lib/server/curation-detail';
import {validateCuratorOutput,type ContextBundle,type CuratorOutput} from '../lib/server/curator-v1/contract';
import {CONTEXT_LIMITS,CorpusKnowledgeRepository} from '../lib/server/knowledge/corpus';
import {observationKey,type KnowledgeDocument,type KnowledgeFilm,type KnowledgeIndex,type KnowledgeObservation,type SemanticNeighbors} from '../lib/server/knowledge/types';

// These deliberately fictional sources isolate identity, retrieval and attribution
// behavior without treating a synthetic observation as a real scholarly claim.
const stamp='2026-09-20T00:00:00.000Z';
const a:KnowledgeFilm={key:'a',title:'The Amber Window',year:1980,director:'Anne Aster',aliases:['황금빛 창'],externalIds:[]};
const b:KnowledgeFilm={key:'b',title:'The Blue Orchard',year:1990,director:'Béla Birch',aliases:['푸른 과수원'],externalIds:[]};
const c:KnowledgeFilm={key:'c',title:'The Copper River',year:2000,director:'Clara Cedar',aliases:[],externalIds:[]};
const runtime=(row:KnowledgeFilm,id=`tmdb:${row.key}`):Film=>({id,title:row.title,year:row.year,director:row.director,poster:''});
const observation=(id:string,filmKeys:string[],patch:Partial<KnowledgeObservation>={}):KnowledgeObservation=>({
 id,summary:'Framing makes duration perceptible.',boundary:'This observation describes only this passage.',filmKeys,subjects:[],kind:'film_reading',passageIds:[id],...patch,
});
function document(id:string,observations:KnowledgeObservation[],patch:Partial<KnowledgeDocument>={}):KnowledgeDocument{
 return {id,url:`https://example.org/${id}`,title:id,author:null,publisher:'Synthetic fixture',type:'criticism',language:'en',publishedAt:null,checkedAt:stamp,
  access:'full_page',rights:{mode:'restricted_excerpt',licenseUrl:null,note:'Synthetic test fixture.'},verification:{method:'web_open',locator:'paragraph 1',note:'Synthetic test fixture.'},
  films:[a,b,c],passages:observations.map(row=>({id:row.id,text:'A window makes time visible.',locator:`paragraph ${row.id}`})),observations,
  versionId:`${id}:v1`,contentHash:`fixture-${id}`,reviewStatus:'agent_reviewed',keyMappings:{},...patch};
}
function index(documents:KnowledgeDocument[],films:KnowledgeFilm[]=[a,b,c]):KnowledgeIndex{
 return {version:1,corpusVersion:'fixture-v1',builtAt:stamp,documents,films,stats:{documents:documents.length}};
}
function semantic(neighbors:SemanticNeighbors['neighbors']={},corpusVersion='fixture-v1'):SemanticNeighbors{
 return {version:1,corpusVersion,model:'synthetic-neighbor-fixture',dimensions:3,neighbors};
}
function repository(documents:KnowledgeDocument[],neighbors:SemanticNeighbors=semantic(),films:KnowledgeFilm[]=[a,b,c]){
 return new CorpusKnowledgeRepository(index(documents,films),neighbors);
}
function proposed(context:ContextBundle,selected:Film[],evidenceId=context.passages[0]?.id):CuratorOutput{
 return {lens:'A route through changing forms',description:'A route through changing forms',recommendations:Array.from({length:12},()=>({
  title:b.title,year:b.year,director:b.director,anchorIds:selected.map(film=>film.id),connection:'Duration is reshaped through a contrasting frame.',evidenceIds:evidenceId?[evidenceId]:[],attribution:evidenceId?'source_explicit':'model_proposal',
 }))};
}

test('equal selected sets yield identical context regardless of trail order',async()=>{
 const docs=[document('amber',[observation('reading',[a.key],{subjects:['framing','duration']})]),document('blue',[observation('reading',[b.key],{subjects:['framing','duration']})])];
 const repo=repository(docs,semantic({'amber:reading':[{id:'blue:reading',score:.8}]}));
 assert.deepEqual(await repo.buildContext([runtime(a),runtime(b)],'en'),await repo.buildContext([runtime(b),runtime(a)],'en'));
});

test('aliases require compatible year and director, rejecting homonyms and remote years',async()=>{
 const repo=repository([document('blue',[observation('reading',[b.key])])]);
 const alias={...runtime(b),title:'푸른 과수원',year:1991,director:'Birch Bela'};
 const valid=await repo.buildContext([alias],'en');
 assert.equal(valid.passages.length,1);
 assert.ok(valid.passages[0].filmIds.includes(alias.id));
 assert.equal((await repo.buildContext([{...alias,director:'Different Director'}],'en')).passages.length,0);
 assert.equal((await repo.buildContext([{...alias,year:1993}],'en')).passages.length,0);
});

test('authoritative external identity works even when localized metadata differs',async()=>{
 const authoritative={...b,externalIds:['tmdb:42']};
 const repo=repository([document('blue',[observation('reading',[b.key])])],semantic(),[a,authoritative,c]);
 const context=await repo.buildContext([{id:'tmdb:42',title:'Different localized label',year:1990,director:'',poster:''}],'ko');
 assert.equal(context.passages.length,1);
 assert.ok(context.passages[0].filmIds.includes('tmdb:42'));
});

test('object-form Wikidata identity resolves the same source without relying on title similarity',async()=>{
 const authoritative:KnowledgeFilm={...b,externalIds:[{provider:'wikidata',id:'Q123'}]};
 const repo=repository([document('blue',[observation('reading',[b.key])])],semantic(),[a,authoritative,c]);
 const selected:Film={id:'tmdb:4242',wikidataId:'Q123',title:'Different localized label',year:1990,director:'',poster:''};
 const context=await repo.buildContext([selected],'ko');
 assert.equal(context.passages.length,1);
 assert.ok(context.passages[0].filmIds.includes(selected.id));
 assert.equal(context.passages[0].retrievalRole,'selected_reading');
});

test('unknown films remain valid inputs; synopsis retrieval is context, not false film identity',async()=>{
 const repo=repository([document('river',[observation('reading',[c.key],{subjects:['duration','landscape']})])]);
 const unknown:Film={id:'tmdb:unknown',title:'An Uncatalogued Film',year:2026,director:'New Filmmaker',poster:'',overviewEn:'Duration and landscape structure this journey.'};
 const context=await repo.buildContext([unknown],'en');
 assert.deepEqual(context.selectedFilmIds,[unknown.id]);
 assert.equal(context.passages.length,1);
 assert.equal(context.passages[0].retrievalRole,'related_context');
 assert.deepEqual(context.passages[0].retrievedFor,[unknown.id]);
 assert.equal(context.passages[0].filmIds.includes(unknown.id),false);
 assert.equal((await repo.buildContext([{...unknown,overviewEn:''}],'en')).passages.length,0);
});

test('a semantic neighbor shared by seeds cannot consume another seed’s direct-reading opportunity',async()=>{
 const directA=document('zz-amber',[observation('reading',[a.key])]);
 const directB=Array.from({length:20},(_,n)=>document(`blue-${n.toString().padStart(2,'0')}`,[observation('reading',[b.key])]));
 const graph=semantic({'zz-amber:reading':directB.map(doc=>({id:`${doc.id}:reading`,score:.9}))});
 const context=await repository([directA,...directB],graph).buildContext([runtime(a),runtime(b)],'en');
 assert.ok(context.passages.some(p=>p.documentId===directA.id),'the less multiply-retrieved direct reading must still enter the bounded context');
 const blue=context.passages.find(p=>p.documentId.startsWith('blue-'))!;
 assert.deepEqual(blue.retrievedFor,[runtime(a).id,runtime(b).id].sort());
 assert.ok(blue.filmIds.includes(runtime(b).id));
 assert.equal(blue.filmIds.includes(runtime(a).id),false,'retrieval relevance cannot turn into documented film presence');
});

test('incidental mentions and unavailable source text never enter curator evidence',async()=>{
 const docs=[
  document('incidental',[observation('mention',[a.key],{kind:'incidental_mention'})]),
  document('metadata',[observation('reading',[a.key])],{access:'metadata_only'}),
  document('abstract',[observation('reading',[a.key])],{type:'academic',access:'abstract'}),
  document('restricted',[observation('reading',[a.key])],{rights:{mode:'metadata_only',licenseUrl:null,note:'Metadata only.'}}),
  document('orphan',[observation('reading',[a.key],{passageIds:['missing']})]),
  document('valid',[observation('reading',[a.key])]),
 ];
 const context=await repository(docs).buildContext([runtime(a)],'en');
 assert.deepEqual(context.passages.map(p=>p.documentId),['valid']);
});

test('semantic edges are used only for the exact corpus version and above the confidence floor',async()=>{
 const docs=[document('amber',[observation('reading',[a.key])]),document('blue',[observation('reading',[b.key])]),document('river',[observation('reading',[c.key])])];
 const neighbors={'amber:reading':[{id:'blue:reading',score:.8},{id:'river:reading',score:.47},{id:'missing:reading',score:1}]};
 const fresh=await repository(docs,semantic(neighbors)).buildContext([runtime(a)],'en');
 assert.deepEqual(new Set(fresh.passages.map(p=>p.documentId)),new Set(['amber','blue']));
 const stale=await repository(docs,semantic(neighbors,'fixture-old')).buildContext([runtime(a)],'en');
 assert.deepEqual(stale.passages.map(p=>p.documentId),['amber']);
});

test('context obeys passage, document and serialized character budgets under dense matches',async()=>{
 const docs=Array.from({length:30},(_,n)=>document(`d${n}`,[observation('one',[a.key]),observation('two',[a.key]),observation('three',[a.key])]));
 const context=await repository(docs).buildContext([runtime(a)],'en');
 assert.ok(context.passages.length>0);
 assert.ok(context.passages.length<=CONTEXT_LIMITS.passages);
 assert.ok(context.passages.reduce((size,p)=>size+JSON.stringify(p).length,0)<=CONTEXT_LIMITS.characters);
 for(const id of new Set(context.passages.map(p=>p.documentId)))assert.ok(context.passages.filter(p=>p.documentId===id).length<=CONTEXT_LIMITS.perDocument);
 const longDocs=docs.map(doc=>({...doc,observations:doc.observations.map(row=>({...row,summary:'A'.repeat(1190),summaryKo:'나'.repeat(1190),boundary:'B'.repeat(890)}))}));
 const long=await repository(longDocs).buildContext([runtime(a)],'ko');
 assert.ok(long.passages.length>0&&long.passages.length<context.passages.length,'long context is bounded by characters before the passage ceiling');
 assert.ok(long.passages.reduce((size,p)=>size+JSON.stringify(p).length,0)<=15_000);
});

test('more than eight selected films preserve identities and receive direct readings when they fit',async()=>{
 const films=Array.from({length:10},(_,n):KnowledgeFilm=>({key:`f${n}`,title:`Film ${n}`,year:1980+n,director:`Director ${n}`,aliases:[],externalIds:[]}));
 const docs=films.map(film=>document(`d${film.key}`,[observation('reading',[film.key])],{films:[film]}));
 const selected=films.map(film=>runtime(film));
 const context=await repository(docs,semantic(),films).buildContext(selected,'en');
 assert.equal(context.selectedFilmIds.length,10);
 for(const film of selected)assert.ok(context.passages.some(p=>p.filmIds.includes(film.id)),`missing ${film.id}`);
});

test('full-paper access, translations, review status and scope boundaries survive retrieval',async()=>{
 const obs=observation('abstract',[a.key],{summary:'The passage identifies a contrast in duration.',summaryKo:'본문은 지속 시간의 대조를 설명한다.',boundary:'Only this section supports the observation; it is not the full argument.'});
 const doc=document('full-paper',[obs],{type:'academic',access:'full_page',publishedAt:'2021-01-01',rights:{mode:'noncommercial',licenseUrl:'https://example.org/license',note:'Noncommercial.'}});
 const repo=repository([doc]),ko=(await repo.buildContext([runtime(a)],'ko')).passages[0],en=(await repo.buildContext([runtime(a)],'en')).passages[0];
 assert.equal(ko.observation,obs.summaryKo);assert.equal(en.observation,obs.summary);
 assert.equal(ko.accessLevel,'full_page');assert.equal(ko.reviewState,'agent_reviewed');assert.equal(ko.rights,'noncommercial');
 assert.equal(ko.boundary,obs.boundary);assert.equal(ko.versionId,doc.versionId);assert.equal(ko.locator,doc.passages[0].locator);
 assert.equal(ko.excerpt,doc.passages[0].text);assert.equal(ko.publishedAt,'2021-01-01');
});

test('co-programming stays contextual even when an exact programme quote names both films',async()=>{
 const doc=document('programme',[observation('programme',[a.key,b.key],{kind:'co_programming'})],{type:'programme',passages:[{id:'programme',text:`${a.title} and ${b.title} were shown in this programme.`,locator:'programme introduction'}]});
 const selected=[runtime(a)],context=await repository([doc]).buildContext(selected,'en');
 const output=validateCuratorOutput(proposed(context,selected),{selected,excludedIds:[],language:'en',context});
 assert.ok(output.recommendations.every(p=>p.attribution==='source_supported_interpretation'));
});

test('even a located comparison naming both films leaves the generated connection an interpretation',async()=>{
 const doc=document('comparison',[observation('comparison',[a.key,b.key],{kind:'comparison'})],{passages:[{id:'comparison',text:`${a.title} treats duration differently from ${b.title}.`,locator:'paragraph 4'}]});
 const selected=[runtime(a)],context=await repository([doc]).buildContext(selected,'en');
 const output=validateCuratorOutput(proposed(context,selected),{selected,excludedIds:[],language:'en',context});
 assert.ok(output.recommendations.every(p=>p.attribution==='source_supported_interpretation'));
 const overclaim=proposed(context,selected);
 overclaim.recommendations[0].connection='The director explicitly copied the earlier film and acknowledged its decisive influence.';
 const guarded=validateCuratorOutput(overclaim,{selected,excludedIds:[],language:'en',context});
 assert.equal(guarded.recommendations[0].attribution,'source_supported_interpretation','a documented comparison cannot certify invented influence');
 const batch=curatorDecisionBatch({lens:guarded.lens,description:guarded.description,recommendations:guarded.recommendations.map(p=>({...p,film:runtime(b)}))},selected,context,'en',()=>undefined);
 assert.ok(batch.recommendations.every(p=>p.connections[0].relation==='grounded_interpretation'));
 assert.equal(batch.sources[0].summary,doc.observations[0].summary,'the source card retains the author observation separately');
 const wrong=proposed(context,selected);wrong.recommendations[0].director='Wrong Director';
 assert.equal(validateCuratorOutput(wrong,{selected,excludedIds:[],language:'en',context}).recommendations[0].attribution,'source_supported_interpretation');
});

test('comparison labels and database participants cannot replace both names in the located quote',async()=>{
 const doc=document('comparison',[observation('comparison',[a.key,b.key],{kind:'comparison'})],{passages:[{id:'comparison',text:`${a.title} treats duration as a formal problem.`,locator:'paragraph 4'}]});
 const selected=[runtime(a)],context=await repository([doc]).buildContext(selected,'en');
 const output=validateCuratorOutput(proposed(context,selected),{selected,excludedIds:[],language:'en',context});
 assert.ok(output.recommendations.every(p=>p.attribution==='source_supported_interpretation'));
});

test('production source adapter and signed detail packet retain bounded source provenance',async()=>{
 const obs=observation('abstract',[a.key],{summary:'An argument in the article body.',summaryKo:'본문에서 확인한 주장.',boundary:'This passage only; connection to the recommended film is an interpretation.'});
 const doc=document('paper',[obs],{type:'academic',access:'full_page',publishedAt:'2022-03-04'});
 const selected=[runtime(a)],context=await repository([doc]).buildContext(selected,'ko');
 const old=process.env.OPENAI_API_KEY;
 process.env.OPENAI_API_KEY='synthetic-local-signing-key-no-network';
 try{
  const batch=curatorDecisionBatch({lens:'A route through duration',description:'A route through duration',recommendations:[{film:runtime(b),anchorIds:[runtime(a).id],connection:'The source suggests a possible contrasting treatment.',evidenceIds:[observationKey(doc.id,obs.id)],attribution:'source_supported_interpretation'}]},selected,context,'ko',issueDetailToken);
  assert.equal(batch.sources.length,1);
  const source=batch.sources[0];
  assert.equal(source.accessLevel,'full_page');assert.equal(source.reviewStatus,'agent_reviewed');assert.equal(source.boundary,obs.boundary);
  assert.equal(source.documentId,doc.id);assert.equal(source.documentVersion,doc.versionId);assert.equal(source.date,'2022-03-04');
  assert.equal(source.excerpt,doc.passages[0].text);assert.equal(source.summaryKo,obs.summaryKo);
  const token=batch.recommendations[0].detailToken;assert.ok(token);
  const packet=readDetailToken(token,new Map([[doc.id,doc.versionId]]));
  assert.equal(packet.version,2);
  assert.equal(packet.evidence.length,1);assert.equal(packet.evidence[0].access,'full_page');assert.equal(packet.evidence[0].review,'agent_reviewed');
  assert.equal(packet.evidence[0].boundary,obs.boundary);assert.equal(packet.evidence[0].locator,doc.passages[0].locator);assert.equal(packet.evidence[0].excerpt,doc.passages[0].text);
  assert.equal(packet.evidence[0].documentId,doc.id);assert.equal(packet.evidence[0].documentVersion,doc.versionId);
  assert.throws(()=>readDetailToken(token,new Map()),/source was removed or revised/i);
  assert.throws(()=>readDetailToken(token,new Map([[doc.id,'revised-version']])),/source was removed or revised/i);
  assert.equal(batch.recommendations[0].connections[0].relation,'grounded_interpretation');
 }finally{if(old===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=old;}
});


test('new imports are scored before context caps, including beyond old posting cutoffs',async()=>{
 const many=Array.from({length:2100},(_,n)=>document(`early-${n}`,[observation('reading',[a.key],{subjects:['duration','landscape']})]));
 const best=document('late-best',[observation('reading',[a.key,b.key],{subjects:['duration','landscape','granular','rhythm']})]);
 const repo=repository([...many,best]);
 const direct=await repo.buildContext([runtime(a),runtime(b)],'en');
 assert.ok(direct.passages.some(p=>p.documentId===best.id),'a late comparison spanning both seeds must not disappear behind a first-96 cutoff');
 const unknown:Film={id:'tmdb:unknown',title:'Unknown',year:2026,director:'Unlisted',poster:'',overviewEn:'Duration landscape granular rhythm.'};
 const lexical=await repo.buildContext([unknown],'en');
 assert.ok(lexical.passages.some(p=>p.documentId===best.id),'a strong late lexical hit must not disappear behind a first-2048 posting cutoff');
});
