import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import nextEnv from '@next/env';
import {z} from 'zod';
import {FilmSchema,type Language} from '../lib/domain';

const HELP=`STRADA curator_v1 benchmark (no API calls unless --run)

npm run benchmark:curator-v1 -- --case matter-and-sky
npm run benchmark:curator-v1 -- --run --case all --models gpt-5.6-terra --repeat 1 --out work/curator-v1.json

--case ID,ID|all      Fixed cases from research/curator/eval-cases.json
--models M1,M2        One to three models; Sol is rejected. Default: gpt-5.6-terra
--repeat N            One or two runs per case/model. Default: 1
--reasoning LEVEL     none|low|medium|high|xhigh|max|omit. Default: none
--deadline-ms N       Main curator deadline. Default: 15750 (repair may use the remaining 3.75s)
--max-output-tokens N Output plus reasoning budget. Default: 2000
--language ko|en      Default: ko
--out FILE.json       Write a report without secrets
--run                 Permit real API calls and charges
--help                Show this help
`;
const CasesSchema=z.object({version:z.literal(1),cases:z.array(z.object({id:z.string(),label:z.string(),selected:z.array(FilmSchema).min(1).max(8)}))});
export type CuratorV1BenchmarkOptions={run:boolean;help:boolean;caseIds:string[]|'all';models:string[];repeat:number;reasoning:'none'|'low'|'medium'|'high'|'xhigh'|'max'|null;deadlineMs:number;maxOutputTokens:number;language:Language;out?:string};

export function parseCuratorV1BenchmarkOptions(argv:string[]):CuratorV1BenchmarkOptions{
 const values:Record<string,string>={},switches=new Set<string>();
 for(let i=0;i<argv.length;i++){
  if(!argv[i].startsWith('--'))throw new Error('Use named options; see --help.');const name=argv[i].slice(2);
  if(name==='run'||name==='help'){switches.add(name);continue;}
  if(!['case','models','repeat','reasoning','deadline-ms','max-output-tokens','language','out'].includes(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Unknown option or missing value; see --help.');
  values[name]=argv[++i];
 }
 const models=(values.models??'gpt-5.6-terra').split(',').map(value=>value.trim()).filter(Boolean);
 if(!models.length||models.length>3||new Set(models).size!==models.length)throw new Error('Choose one to three distinct models.');
 if(models.some(model=>/(?:^|[-_.])sol(?:$|[-_.])/i.test(model)))throw new Error('Sol is excluded from this experiment.');
 const caseValue=values.case??'matter-and-sky',caseIds=caseValue==='all'?'all':caseValue.split(',').map(value=>value.trim()).filter(Boolean);
 if(caseIds!=='all'&&(!caseIds.length||new Set(caseIds).size!==caseIds.length))throw new Error('Choose one or more distinct case IDs, or all.');
 const repeat=Number(values.repeat??1);if(!Number.isInteger(repeat)||repeat<1||repeat>2)throw new Error('--repeat must be 1 or 2.');
 const reasoningValue=values.reasoning??'none';if(!['none','low','medium','high','xhigh','max','omit'].includes(reasoningValue))throw new Error('Invalid --reasoning.');
 const reasoning=reasoningValue==='omit'?null:reasoningValue as Exclude<CuratorV1BenchmarkOptions['reasoning'],null>;
 const deadlineMs=Number(values['deadline-ms']??15750);if(!Number.isInteger(deadlineMs)||deadlineMs<1000||deadlineMs>60000)throw new Error('--deadline-ms must be 1000–60000.');
 const maxOutputTokens=Number(values['max-output-tokens']??2000);if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<700||maxOutputTokens>6000)throw new Error('--max-output-tokens must be 700–6000.');
 const language=values.language??'ko';if(language!=='ko'&&language!=='en')throw new Error('--language must be ko or en.');
 if(values.out&&!values.out.endsWith('.json'))throw new Error('--out must be a .json file.');
 return {run:switches.has('run'),help:switches.has('help'),caseIds,models,repeat,reasoning,deadlineMs,maxOutputTokens,language,out:values.out};
}

type Runtime={runCuratorV1:typeof import('../lib/server/curator-v1/engine')['runCuratorV1'];SnapshotKnowledgeRepository:typeof import('../lib/server/knowledge/snapshot')['SnapshotKnowledgeRepository']};
const loadRuntime=async():Promise<Runtime>=>({...await import('../lib/server/curator-v1/engine'),SnapshotKnowledgeRepository:(await import('../lib/server/knowledge/corpus')).CorpusKnowledgeRepository as unknown as Runtime['SnapshotKnowledgeRepository']});
const errorCode=(error:unknown)=>error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:error instanceof Error?error.message:'BENCHMARK_FAILED';
const errorDetails=(error:unknown)=>error&&typeof error==='object'&&'details'in error&&error.details&&typeof error.details==='object'?error.details:undefined;

export async function runCuratorV1Benchmark(options:CuratorV1BenchmarkOptions,runtimeLoader:()=>Promise<Runtime>=loadRuntime){
 const cases=CasesSchema.parse(JSON.parse(await readFile(resolve('research/curator/eval-cases.json'),'utf8')));
 const chosen=options.caseIds==='all'?cases.cases:options.caseIds.map(id=>{const item=cases.cases.find(candidate=>candidate.id===id);if(!item)throw new Error(`Unknown case: ${id}`);return item;});
 const request={cases:chosen.map(item=>({caseId:item.id,label:item.label,selected:item.selected.map(({id,title,year,director})=>({id,title,year,director}))})),models:options.models,repeat:options.repeat,reasoning:options.reasoning,deadlineMs:options.deadlineMs,maxOutputTokens:options.maxOutputTokens,language:options.language};
 if(!options.run)return {version:1,dryRun:true,request,message:'No API calls were made. Add --run to execute the experiment.'};
 if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is missing.');
 const runtime=await runtimeLoader(),repository=new runtime.SnapshotKnowledgeRepository(),runs:Record<string,unknown>[]=[],started=Date.now();
 for(const chosenCase of chosen)for(let repetition=1;repetition<=options.repeat;repetition++)for(const model of options.models){
  const runStarted=Date.now();
  try{
   const result=await runtime.runCuratorV1({selected:chosenCase.selected,excludedIds:[],language:options.language,repository,
    options:{model,reasoning:options.reasoning,timeoutMs:options.deadlineMs,maxOutputTokens:options.maxOutputTokens,promptVersion:'v2',repair:{model:'gpt-5.4',timeoutMs:3750,maxOutputTokens:1100}},signal:AbortSignal.timeout(options.deadlineMs+4250)});
   const counts=Object.fromEntries(['source_explicit','source_supported_interpretation','model_proposal'].map(kind=>[kind,result.decision.recommendations.filter(rec=>rec.attribution===kind).length]));
   runs.push({caseId:chosenCase.id,repetition,model,ok:true,wallMs:Date.now()-runStarted,timings:result.timings,usage:result.usage,contextFingerprint:result.contextFingerprint,contextPassageCount:result.contextPassageCount,contextCoverage:result.contextCoverage,
    repair:result.repair,attributionCounts:counts,lens:result.decision.lens,recommendations:result.decision.recommendations.map(rec=>({id:rec.film.id,title:rec.film.title,titleKo:rec.film.titleKo,year:rec.film.year,director:rec.film.director,connection:rec.connection,anchorIds:rec.anchorIds,evidenceIds:rec.evidenceIds,attribution:rec.attribution}))});
  }catch(error){runs.push({caseId:chosenCase.id,repetition,model,ok:false,wallMs:Date.now()-runStarted,error:errorCode(error),details:errorDetails(error)});}
 }
 const summary=Object.fromEntries(options.models.map(model=>{
  const modelRuns=runs.filter(run=>run.model===model),success=modelRuns.filter(run=>run.ok===true),latencies=success.flatMap(run=>typeof (run.timings as {totalMs?:unknown}|undefined)?.totalMs==='number'?[(run.timings as {totalMs:number}).totalMs]:[]).sort((a,b)=>a-b);
  const percentile=(p:number)=>latencies.length?latencies[Math.min(latencies.length-1,Math.ceil(latencies.length*p)-1)]:null;
  return [model,{attempts:modelRuns.length,successes:success.length,successRate:modelRuns.length?success.length/modelRuns.length:0,within20s:latencies.filter(ms=>ms<=20_000).length,
   within20sRate:modelRuns.length?latencies.filter(ms=>ms<=20_000).length/modelRuns.length:0,p50Ms:percentile(.5),p95Ms:percentile(.95),estimatedUsd:success.reduce((sum,run)=>sum+Number((run.usage as {estimatedUsd?:number}|undefined)?.estimatedUsd??0),0)}];
 }));
 return {version:1,dryRun:false,createdAt:new Date().toISOString(),request,corpusVersion:'curator-v1-pilot-2026-09-20',summary,runs,totalWallMs:Date.now()-started,
  note:'Stage-1 feasibility measurement. It is not an expert-quality claim; source attribution still requires human review.'};
}

async function main(){
 try{
  nextEnv.loadEnvConfig(process.cwd());const options=parseCuratorV1BenchmarkOptions(process.argv.slice(2));if(options.help){console.log(HELP);return;}
  if(options.out)try{await lstat(resolve(options.out));throw new Error('Output already exists.');}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
  const report=await runCuratorV1Benchmark(options),serialized=JSON.stringify(report,null,2)+'\n';
  if(options.out){const target=resolve(options.out);await mkdir(dirname(target),{recursive:true});await writeFile(target,serialized,{mode:0o600,flag:'wx'});}console.log(serialized.trimEnd());
  if('runs'in report&&Array.isArray(report.runs)&&report.runs.some(run=>run.ok===false))process.exitCode=1;
 }catch(error){console.error(`STRADA curator_v1 benchmark: ${errorCode(error)}`);process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
