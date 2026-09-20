import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import nextEnv from '@next/env';
import {runCuratorProduction} from '../lib/server/curator-production';
import {explainFilm} from '../lib/server/curation-detail';
import {RecommendationSchema,SourceSchema,type Film,type ResearchIntent} from '../lib/domain';
import {z} from 'zod';

nextEnv.loadEnvConfig(process.cwd());
const args=process.argv.slice(2),get=(name:string)=>{const at=args.indexOf(name);return at>=0?args[at+1]:undefined;};
const url=get('--url'),out=resolve(get('--out')??'work/knowledge/production-smoke.json');
const cases=[
 {id:'closeup',seeds:['closeup']},
 {id:'user-three',seeds:['tmdb:54986','tmdb:85350','tmdb:15804']},
 {id:'oharu-goodmorning',seeds:['tmdb:43364','tmdb:28276']},
 {id:'american-time',seeds:['tmdb:85350','tmdb:688']},
 {id:'non-corpus-input',seeds:['tmdb:496243']},
];
const chosen=get('--case')?cases.filter(c=>get('--case')!.split(',').includes(c.id)):cases;
if(!args.includes('--run')){console.log(JSON.stringify({dryRun:true,cases:chosen,url:url??'local-production-engine',followAndRegenerate:args.includes('--workflow')},null,2));process.exit(0);}
if(!chosen.length)throw new Error('No matching smoke cases.');
type Result={recommendations:z.infer<typeof RecommendationSchema>[];sources:z.infer<typeof SourceSchema>[];seeds:Film[];trail:Film[];diagnostics?:Record<string,unknown>;timings?:Record<string,unknown>};
const runs:Record<string,unknown>[]=[],started=Date.now();let first:Result|undefined,lastInput:string[]=[];
async function run(id:string,seeds:string[],trail:string[]=[],intent:ResearchIntent='initial',previous?:Result){
 const input={requestId:`smoke-${id}-${Date.now()}`,baseSnapshotId:previous?'smoke-base':null,seeds,trail,language:(get('--language')==='en'?'en':'ko') as 'en'|'ko',intent,previousIds:previous?.recommendations.map(r=>r.film.id)??[],seenIds:previous?.recommendations.map(r=>r.film.id)??[],discoveredFilms:previous?.recommendations.map(r=>r.film)??[]};
 const start=Date.now();
 try{
  let data:Result;
  if(url){const response=await fetch(url.replace(/\/$/,'')+'/api/recommendations',{method:'POST',headers:{'Content-Type':'application/json',Origin:new URL(url).origin},body:JSON.stringify(input),signal:AbortSignal.timeout(26_000)});if(!response.ok){const err=await response.json() as {error?:{code:string}};throw new Error(`HTTP_${response.status}:${err.error?.code??'unknown'}`);}data=await response.json() as Result;}
  else{const result=await runCuratorProduction(input,AbortSignal.timeout(21_000));data={...result.batch,seeds:result.seeds,trail:result.trail,diagnostics:result.diagnostics,timings:result.timings};}
  z.array(RecommendationSchema).length(12).parse(data.recommendations);z.array(SourceSchema).parse(data.sources);
  const ids=data.recommendations.map(r=>r.film.id),excluded=new Set([...seeds,...trail,...input.previousIds]);
  if(new Set(ids).size!==12||ids.some(value=>excluded.has(value)))throw new Error('Duplicate or excluded films were shown.');
  if(data.sources.some(s=>s.type==='academic'&&s.accessLevel==='abstract'))throw new Error('Abstract-only academic source leaked.');
  const sourceIds=new Set(data.sources.map(s=>s.id));if(data.recommendations.some(r=>r.sourceIds.some(id=>!sourceIds.has(id))))throw new Error('Broken source link.');
  const elapsedMs=Date.now()-start;
  runs.push({id,ok:true,elapsedMs,within20s:elapsedMs<=20_000,diagnostics:data.diagnostics,timings:data.timings,selected:[...data.seeds,...data.trail].map(({id,title,year,director})=>({id,title,year,director})),sources:data.sources,recommendations:data.recommendations.map(({detailToken:_token,...r})=>{void _token;return r;})});
  console.log(JSON.stringify({id,ok:true,elapsedMs,sourceCount:data.sources.length,diagnostics:data.diagnostics}));return data;
 }catch(error){const elapsedMs=Date.now()-start;runs.push({id,ok:false,elapsedMs,error:error instanceof Error?error.message:'unknown'});console.log(JSON.stringify({id,ok:false,elapsedMs,error:error instanceof Error?error.message:'unknown'}));}
}
for(const test of chosen){const result=await run(test.id,test.seeds);if(!first&&result){first=result;lastInput=test.seeds;}}
if(args.includes('--workflow')&&first){await run('regenerate',lastInput,[],'regenerate',first);await run('follow',lastInput,[first.recommendations[0].film.id],'follow',first);await run('manual',lastInput,['tmdb:20530'],'manual',first);}
if(args.includes('--detail')&&first){const rec=first.recommendations.find(r=>r.sourceIds.length&&r.detailToken)??first.recommendations.find(r=>r.detailToken);if(rec?.detailToken){const start=Date.now();try{let result:{paragraphs:string[]};if(url){const response=await fetch(url.replace(/\/$/,'')+'/api/recommendations/explain',{method:'POST',headers:{'Content-Type':'application/json',Origin:new URL(url).origin},body:JSON.stringify({token:rec.detailToken,language:'ko'}),signal:AbortSignal.timeout(32_000)});if(!response.ok)throw new Error(`Detail HTTP ${response.status}`);result=await response.json() as {paragraphs:string[]};}else result=await explainFilm(rec.detailToken,'ko',AbortSignal.timeout(31_000));runs.push({id:'detail',ok:result.paragraphs.length>=2,elapsedMs:Date.now()-start,film:rec.film.title,paragraphs:result.paragraphs});}catch(error){runs.push({id:'detail',ok:false,elapsedMs:Date.now()-start,error:error instanceof Error?error.message:'unknown'});}}}
const listRuns=runs.filter(r=>r.id!=='detail'),success=listRuns.filter(r=>r.ok),times=listRuns.map(r=>Number(r.elapsedMs)).sort((a,b)=>a-b);
const report={at:new Date().toISOString(),url:url??'local-production-engine',elapsedMs:Date.now()-started,summary:{attempts:listRuns.length,successes:success.length,within20s:success.filter(r=>r.within20s).length,failures:listRuns.length-success.length,p50AllAttempts:times[Math.floor(times.length*.5)],p95AllAttempts:times[Math.min(times.length-1,Math.ceil(times.length*.95)-1)],note:'Small smoke test; failures remain in denominator. Not a latency SLO or a human-quality proof.'},runs};
await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.summary));
if(runs.some(r=>!r.ok))process.exitCode=1;
