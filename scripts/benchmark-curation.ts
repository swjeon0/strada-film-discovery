import {readFile,mkdir,writeFile,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import nextEnv from '@next/env';
import {z} from 'zod';
import {curationSettings} from '../lib/server/curation-settings';
import {FilmSchema,type Language} from '../lib/domain';
import type {PreparedResult} from '../lib/server/preparation';
import type {ResearchResult} from '../lib/server/research';

const HELP=`STRADA local benchmark (no API calls unless --run)

npm run benchmark -- --seeds tmdb:126238,tmdb:43838 --language ko
npm run benchmark -- --run --seeds tmdb:126238,tmdb:43838 --compare-select gpt-5.4-mini,gpt-5.6-terra --out work/comparison.json

--seeds ID,ID            1–8 distinct film IDs; required
--language ko|en         Default: ko
--profile NAME           A profile in config/curation.json
--select-model MODEL     Override the final selection model
--draft-model MODEL      Override candidate generation model
--write-model MODEL      Override parallel explanation writing model
--detail-model MODEL     Override the detail model (detail is not called here)
--search-model MODEL     Override reference search model
--select-reasoning LEVEL Also accepts --draft/--write/--detail/--search-reasoning
--compare-select M1,M2   Compare final models on one prepared candidate/source pool
--preparation FILE       Load an explicitly saved, signed preparation
--save-preparation FILE  Save preparation for another local run (private file)
--prepare-only          Stop after preparing candidates and sources
--out FILE.json          Save a report without keys or signed tokens
--run                    Permit real API calls and their charges
--help                   Show this help
`;
const modelFlags=['draft','select','write','detail','search'] as const;
const valueFlags=new Set(['seeds','language','profile','compare-select','preparation','save-preparation','out',...modelFlags.flatMap(stage=>[stage+'-model',stage+'-reasoning'])]);
export type BenchmarkOptions={run:boolean;help:boolean;seeds:string[];language:Language;prepareOnly:boolean;out?:string;preparation?:string;savePreparation?:string;compareModels:string[];environment:Record<string,string>};
export function parseBenchmarkOptions(argv:string[]):BenchmarkOptions{
 const values:Record<string,string>={},switches=new Set<string>();
 for(let i=0;i<argv.length;i++){
  const name=argv[i].replace(/^--/,'');
  if(!argv[i].startsWith('--'))throw new Error('Use named options; see --help.');
  if(['run','help','prepare-only'].includes(name)){switches.add(name);continue;}
  if(!valueFlags.has(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Unknown option or missing value; see --help.');
  values[name]=argv[++i];
 }
 const seeds=(values.seeds??'').split(',').map(value=>value.trim()).filter(Boolean),language=values.language??'ko';
 if(!switches.has('help')&&(seeds.length<1||seeds.length>8||new Set(seeds).size!==seeds.length||seeds.some(id=>!/^(?:tmdb:\d+|wd:Q\d+|[a-z0-9][a-z0-9-]{0,100})$/.test(id))))throw new Error('--seeds must contain 1–8 distinct valid film IDs.');
 if(language!=='ko'&&language!=='en')throw new Error('--language must be ko or en.');
 if(values.out&&!values.out.endsWith('.json'))throw new Error('--out must be a .json file.');
 const compareModels=(values['compare-select']??'').split(',').map(value=>value.trim()).filter(Boolean);
 if(compareModels.length>4||new Set(compareModels).size!==compareModels.length)throw new Error('Compare at most four distinct selection models per run.');
 if(compareModels.length&&values['select-model'])throw new Error('Choose either --select-model or --compare-select.');
 const environment:Record<string,string>={};
 if(values.profile)environment.STRADA_PROFILE=values.profile;
 for(const stage of modelFlags)for(const field of ['model','reasoning'])if(values[stage+'-'+field])environment[`OPENAI_${stage.toUpperCase()}_${field.toUpperCase()}`]=values[stage+'-'+field];
 return {run:switches.has('run'),help:switches.has('help'),prepareOnly:switches.has('prepare-only'),seeds,language,out:values.out,preparation:values.preparation,savePreparation:values['save-preparation'],compareModels,environment};
}

const SavedPreparation=z.object({version:z.literal(1),createdAt:z.string(),seedIds:z.array(z.string()),language:z.enum(['ko','en']),selected:z.array(FilmSchema),token:z.string().max(220000)});
type Phase={stage:string;model:string;elapsedMs:number;inputTokens:number;outputTokens:number};
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:0;
export function summarizeResearch(result:ResearchResult){
 return {
  timings:result.timings,usage:result.usage,count:result.batch.recommendations.length,
  sourcedCount:result.batch.recommendations.filter(rec=>rec.sourceIds.length>0).length,
  uniqueSourceCount:new Set(result.batch.sources.map(source=>source.url)).size,
  sources:result.batch.sources.map(({title,url,excerpt,summary,type})=>({title,url,excerpt,summary,type})),
  recommendations:result.batch.recommendations.map(rec=>({id:rec.film.id,title:rec.film.title,titleKo:rec.film.titleKo,year:rec.film.year,director:rec.film.director,why:rec.connections[0]?.whyKo??rec.connections[0]?.why,curation:rec.curation,sourceIds:rec.sourceIds})),
 };
}
export type BenchmarkEngine=Pick<typeof import('../lib/server/research'),'research'>&Pick<typeof import('../lib/server/preparation'),'prepareResearch'|'preparationFingerprint'>&Pick<typeof import('../lib/server/preparation-token'),'readPreparationToken'>;
const loadEngine=async():Promise<BenchmarkEngine>=>({...await import('../lib/server/research'),...await import('../lib/server/preparation'),...await import('../lib/server/preparation-token')});
const sameIds=(a:string[],b:string[])=>[...a].sort().join('|')===[...b].sort().join('|');
const publicError=(error:unknown)=>error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'BENCHMARK_FAILED';

/** The no-run branch deliberately precedes backend imports and any API access. */
export async function runBenchmark(options:BenchmarkOptions,engineLoader:()=>Promise<BenchmarkEngine>=loadEngine){
 const previous=new Map(Object.keys(options.environment).map(name=>[name,process.env[name]]));
 for(const [name,value]of Object.entries(options.environment))process.env[name]=value;
 const logs:Phase[]=[],warnings:string[]=[],originalInfo=console.info,originalWarn=console.warn,originalError=console.error;
 try{
  const initial=curationSettings(),models=options.compareModels.length?options.compareModels:[initial.stages.curate.model];
  for(const model of models)curationSettings({env:{...process.env,OPENAI_SELECT_MODEL:model}});
  const request={seeds:options.seeds,language:options.language,profile:initial.profile,models,settings:initial.stages,settingsFingerprint:initial.fingerprint};
  if(!options.run)return {version:1,dryRun:true,request,message:'No API calls were made. Add --run to execute a paid local test.'};
  if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is missing from the local environment.');
  if(!previous.has('OPENAI_SELECT_MODEL'))previous.set('OPENAI_SELECT_MODEL',process.env.OPENAI_SELECT_MODEL);
  // Keep machine-readable stdout free of backend logs and signed payloads.
  console.info=(...items:unknown[])=>{
   if(items[0]!=='STRADA curator phase'||!items[1]||typeof items[1]!=='object')return;
   const phase=items[1] as Record<string,unknown>;
   if(typeof phase.stage==='string'&&typeof phase.model==='string')logs.push({stage:phase.stage,model:phase.model,elapsedMs:number(phase.elapsedMs),inputTokens:number(phase.inputTokens),outputTokens:number(phase.outputTokens)});
  };
  console.warn=(label:unknown)=>{if(typeof label==='string'&&label.startsWith('STRADA '))warnings.push(label);};console.error=()=>{};
  const engine=await engineLoader(),started=Date.now(),signal=AbortSignal.timeout(240000);
  let supplied:string|undefined;
  if(options.preparation){
   const saved=SavedPreparation.parse(JSON.parse(await readFile(resolve(options.preparation),'utf8')));
   if(!sameIds(saved.seedIds,options.seeds)||saved.language!==options.language)throw new Error('Saved preparation uses different film IDs or language.');
   if(!engine.readPreparationToken(saved.token,saved.selected,options.language,engine.preparationFingerprint()))throw new Error('Saved preparation expired or draft/search settings changed. Prepare again before comparing.');
   supplied=saved.token;
  }
  const prepareStarted=Date.now();
  const prepared:PreparedResult=await engine.prepareResearch(options.seeds,[],signal,[],[],{intent:'initial',previousIds:[],language:options.language,preparationToken:supplied});
  const preparationWallMs=Date.now()-prepareStarted,preparationPhases=logs.splice(0),preparationWarnings=warnings.splice(0);
  if(!prepared.preparationToken)throw new Error('This preparation could not be saved; no final-model comparison was started.');
  if(options.savePreparation){
   const target=resolve(options.savePreparation);await mkdir(dirname(target),{recursive:true});
   const state={version:1,createdAt:new Date().toISOString(),seedIds:options.seeds,language:options.language,selected:prepared.preparation.selected,token:prepared.preparationToken};
   await writeFile(target,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});
  }
  const preparation={wallMs:preparationWallMs,timings:prepared.timings,usage:prepared.usage,phases:preparationPhases,warnings:preparationWarnings,candidateCount:prepared.preparation.candidates.length,referenceCount:prepared.preparation.references.length,coveredSeedCount:prepared.preparation.coveredFilmIds.length,reused:prepared.timings.preparationReused};
  const runs:Record<string,unknown>[]=[];let estimatedUsd=prepared.usage.estimatedUsd;
  if(!options.prepareOnly)for(const model of models){
   process.env.OPENAI_SELECT_MODEL=model;
   const settings=curationSettings(),runStarted=Date.now();
   try{
    const result=await engine.research(options.seeds,[],signal,[],[],{intent:'initial',previousIds:[],language:options.language,preparationToken:prepared.preparationToken});
    estimatedUsd+=result.usage.estimatedUsd;
    const runWarnings=warnings.splice(0);
    runs.push({model,settings:settings.stages,settingsFingerprint:settings.fingerprint,wallMs:Date.now()-runStarted,phases:logs.splice(0),warnings:runWarnings,curationFallback:runWarnings.includes('STRADA final curation fallback'),writingFallback:runWarnings.includes('STRADA explanation writing fallback'),...summarizeResearch(result)});
   }catch(error){runs.push({model,wallMs:Date.now()-runStarted,phases:logs.splice(0),warnings:warnings.splice(0),error:publicError(error)});}
  }
  return {version:1,dryRun:false,createdAt:new Date().toISOString(),request,preparation,runs,totalWallMs:Date.now()-started,totalEstimatedUsd:estimatedUsd,costNote:'Estimate from available provider usage. An interrupted or failed request can incur unreported charges; this is not an invoice.'};
 }finally{
  console.info=originalInfo;console.warn=originalWarn;console.error=originalError;
  for(const [name,value]of previous){if(value===undefined)delete process.env[name];else process.env[name]=value;}
 }
}

async function main(){
 try{
  nextEnv.loadEnvConfig(process.cwd());
  const options=parseBenchmarkOptions(process.argv.slice(2));
  if(options.help){console.log(HELP);return;}
  for(const path of [options.out,options.savePreparation].filter((value):value is string=>!!value)){
   try{await lstat(resolve(path));throw new Error('An output file already exists. Choose a new output filename before running.');}
   catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
  }
  const report=await runBenchmark(options),serialized=JSON.stringify(report,null,2)+'\n';
  if(options.out){const file=resolve(options.out);await mkdir(dirname(file),{recursive:true});await writeFile(file,serialized,{mode:0o600,flag:'wx'});}
  console.log(serialized.trimEnd());
  if(report.runs?.some(run=>'error'in run))process.exitCode=1;
 }catch(error){
  // Config/argument errors are generated locally; API/provider payloads are never printed.
  const message=error instanceof Error&&!(error as Error&{code?:string}).code?error.message:publicError(error);
  console.error(`STRADA benchmark: ${message}`);process.exitCode=1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
