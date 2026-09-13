import test from 'node:test';
import assert from 'node:assert/strict';
import {parseBenchmarkOptions,runBenchmark,summarizeResearch,type BenchmarkEngine} from '../scripts/benchmark-curation';
import type {ResearchResult} from '../lib/server/research';
import type {PreparedResult} from '../lib/server/preparation';

const film={id:'tmdb:1',title:'A verified film',year:2000,director:'A director',poster:''};
const timings={metadataMs:1,anchorResearchMs:2,draftMs:3,candidateResolutionMs:4,focusedResearchMs:5,prepareMs:6,selectionMs:7,writingMs:8,totalMs:21,preparationReused:true};
const usage={model:'test-model',inputTokens:100,outputTokens:10,searchCalls:1,estimatedUsd:0.01};
const result:ResearchResult={seeds:[film],trail:[],timings,usage,batch:{mode:'live',preparationToken:'SIGNED_POOL_MUST_NOT_LEAK',sources:[],recommendations:[{film,sourceIds:[],detailToken:'SIGNED_DETAIL_MUST_NOT_LEAK',connections:[{anchorId:film.id,anchorTitle:film.title,why:'A specific relation.',sourceIds:[],relation:'ai_inference'}]}]}};

test('benchmark requires explicit run and validates model comparison arguments before any execution',()=>{
 const options=parseBenchmarkOptions(['--seeds','tmdb:1,tmdb:2','--compare-select','gpt-5.4-mini,gpt-5.6-terra']);
 assert.equal(options.run,false);assert.equal(options.language,'ko');
 assert.deepEqual(options.compareModels,['gpt-5.4-mini','gpt-5.6-terra']);
 assert.throws(()=>parseBenchmarkOptions(['--seeds','tmdb:1,tmdb:1']),/distinct/);
 assert.throws(()=>parseBenchmarkOptions(['--seeds','tmdb:1','--compare-select','gpt-5.4-mini','--select-model','gpt-5.6-terra']),/either/);
 assert.throws(()=>parseBenchmarkOptions(['--seeds','tmdb:1','--out','.env.local']),/json/);
});

test('a dry run does not even load the backend and restores temporary profile overrides',async()=>{
 const previous=process.env.STRADA_PROFILE;let loaded=false;
 const report=await runBenchmark(parseBenchmarkOptions(['--seeds','tmdb:1','--profile','baseline']),async()=>{loaded=true;throw new Error('Must not load the backend for a dry run.');});
 assert.equal(loaded,false);assert.equal(report.dryRun,true);assert.equal(report.request.profile,'baseline');
 assert.equal(process.env.STRADA_PROFILE,previous);
});

test('benchmark reports omit signed preparation and detail tokens but retain film reasons',()=>{
 const serialized=JSON.stringify(summarizeResearch(result));
 assert.equal(serialized.includes('MUST_NOT_LEAK'),false);
 assert.ok(serialized.includes('A specific relation.'));
 assert.ok(serialized.includes('selectionMs'));
});

test('final-model comparison prepares once and passes the identical pool to each model',async t=>{
 const previousKey=process.env.OPENAI_API_KEY,previousModel=process.env.OPENAI_SELECT_MODEL,previousFetch=globalThis.fetch;
 process.env.OPENAI_API_KEY='FAKE_KEY_MUST_NOT_LEAK';
 globalThis.fetch=async()=>{throw new Error('No benchmark unit test may call an external API.');};
 t.after(()=>{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previousKey;});
 let preparations=0;const observed:{model:string|undefined,token:string|undefined}[]=[];
 const prepared:PreparedResult={seeds:[film],trail:[],timings,usage,preparationToken:'SAME_SIGNED_POOL',preparation:{version:1,issued:0,fingerprint:'fixture',language:'ko',selected:[film],lenses:[],queries:[],candidates:[],references:[],coveredFilmIds:[]}};
 const engine:BenchmarkEngine={
  prepareResearch:async()=>{preparations++;return prepared;},
  research:async(_seeds,_trail,_signal,_seen,_discovered,options)=>{observed.push({model:process.env.OPENAI_SELECT_MODEL,token:options?.preparationToken});console.warn('STRADA explanation writing fallback');return result;},
  preparationFingerprint:()=>'',readPreparationToken:()=>null,
 };
 const report=await runBenchmark(parseBenchmarkOptions(['--run','--seeds','tmdb:1','--compare-select','gpt-5.4-mini,gpt-5.6-terra']),async()=>engine);
 assert.equal(preparations,1);
 assert.deepEqual(observed,[{model:'gpt-5.4-mini',token:'SAME_SIGNED_POOL'},{model:'gpt-5.6-terra',token:'SAME_SIGNED_POOL'}]);
 assert.equal(JSON.stringify(report).includes('MUST_NOT_LEAK'),false);
 assert.equal(JSON.stringify(report).includes('SAME_SIGNED_POOL'),false);
 assert.equal(process.env.OPENAI_SELECT_MODEL,previousModel);
 assert.equal('totalEstimatedUsd'in report?report.totalEstimatedUsd:0,0.03);
 assert.ok(report.runs?.every(run=>run.writingFallback===true));
});
