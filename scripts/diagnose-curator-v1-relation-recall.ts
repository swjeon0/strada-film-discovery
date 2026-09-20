import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import nextEnv from '@next/env';
import {z} from 'zod';
import type {Film,Language} from '../lib/domain';
import {ContextBundleSchema,type ContextPassage} from '../lib/server/curator-v1/contract';
import {runCuratorV1} from '../lib/server/curator-v1/engine';
import type {KnowledgeRepository} from '../lib/server/knowledge/repository';
import {SnapshotKnowledgeRepository} from '../lib/server/knowledge/snapshot';
import {resolveCandidates} from '../lib/server/metadata';

const CONDITIONS=['bare','snapshot','dossier'] as const;
type Condition=typeof CONDITIONS[number];

const HELP=`STRADA curator_v1 documented-relation recall diagnostic (no API calls unless --run)

npm run diagnose:curator-v1-relation-recall -- --run --out work/curator-v1-relation-recall.json

--model MODEL          Default: gpt-5.4-mini. Sol is rejected.
--deadline-ms N        Per call deadline. Default: 9500
--max-output-tokens N  Output plus reasoning budget. Default: 1200
--concurrency N        One to four simultaneous calls. Default: 3
--out FILE.json        Report path. Default: work/curator-v1-relation-recall.json
--run                  Permit 36 real API calls and charges
--help                 Show this help
`;

const SeedSchema=z.object({title:z.string(),year:z.number().int(),director:z.string()});
const TargetSchema=SeedSchema.extend({aliases:z.array(z.string())});
const CasesSchema=z.object({version:z.literal(1),description:z.string(),cases:z.array(z.object({
 id:z.string(),recordId:z.string(),class:z.enum(['same_director','cross_director']),seeds:z.array(SeedSchema).min(1).max(3),target:TargetSchema,referenceAxisKo:z.string(),
})).length(12)});
const PilotRowSchema=z.object({id:z.string(),type:z.string(),title:z.string(),author_or_curator:z.string().nullable(),publisher:z.string(),url:z.string().url(),rights:z.string(),entities:z.array(z.string()),relation_role:z.string(),claim_paraphrase_ko:z.string(),context_boundary:z.string(),confidence:z.string(),second_pass_hook:z.string()});

export type RelationRecallOptions={run:boolean;help:boolean;model:string;deadlineMs:number;maxOutputTokens:number;concurrency:number;out:string};
export function parseRelationRecallOptions(argv:string[]):RelationRecallOptions{
 const values:Record<string,string>={},switches=new Set<string>();
 for(let i=0;i<argv.length;i++){
  if(!argv[i].startsWith('--'))throw new Error('Use named options; see --help.');const name=argv[i].slice(2);
  if(name==='run'||name==='help'){switches.add(name);continue;}
  if(!['model','deadline-ms','max-output-tokens','concurrency','out'].includes(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Unknown option or missing value; see --help.');
  values[name]=argv[++i];
 }
 const model=values.model??'gpt-5.4-mini';if(/(?:^|[-_.])sol(?:$|[-_.])/i.test(model))throw new Error('Sol is excluded from this experiment.');
 const deadlineMs=Number(values['deadline-ms']??9500);if(!Number.isInteger(deadlineMs)||deadlineMs<1000||deadlineMs>60000)throw new Error('--deadline-ms must be 1000–60000.');
 const maxOutputTokens=Number(values['max-output-tokens']??1200);if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<700||maxOutputTokens>4000)throw new Error('--max-output-tokens must be 700–4000.');
 const concurrency=Number(values.concurrency??3);if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('--concurrency must be 1–4.');
 const out=values.out??'work/curator-v1-relation-recall.json';if(!out.endsWith('.json'))throw new Error('--out must be a .json file.');
 return {run:switches.has('run'),help:switches.has('help'),model,deadlineMs,maxOutputTokens,concurrency,out};
}

type Case=z.infer<typeof CasesSchema>['cases'][number];
type Recommendation={id:string;t:string;y:number;d:string;b:string;attribution:string;evidenceIds:string[]};
type Run={caseId:string;caseClass:Case['class'];condition:Condition;ok:boolean;elapsedMs:number;model:string;timings?:{contextMs:number;modelMs:number;resolveMs:number;totalMs:number};usage?:{inputTokens:number;outputTokens:number;estimatedUsd:number};lens?:string;recommendations?:Recommendation[];targetRecovered?:boolean;targetRank?:number|null;targetConnection?:string|null;error?:string};

const normalize=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase().replace(/[’‘`´]/g,"'").replace(/\bthe\b/g,'').replace(/[^\p{L}\p{N}]/gu,'');
export function titleMatches(title:string,target:{title:string;aliases:string[]}){const actual=normalize(title);return [target.title,...target.aliases].some(alias=>normalize(alias)===actual);}
function providerError(error:unknown){if(error&&typeof error==='object'&&'code'in error&&typeof error.code==='string')return error.code;if(error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name))return 'TIMEOUT';return error instanceof Error?error.message:'EVALUATION_FAILED';}

class EmptyKnowledgeRepository implements KnowledgeRepository{
 fingerprint(){return 'stage-1.5-empty';}
 async buildContext(selected:Film[],language:Language){void language;return ContextBundleSchema.parse({version:1,corpusVersion:'stage-1.5-empty',builtAt:'2026-09-20T00:00:00.000Z',selectedFilmIds:selected.map(film=>film.id).sort(),passages:[],legacyNotes:[]});}
}
class DossierKnowledgeRepository implements KnowledgeRepository{
 constructor(private readonly testCase:Case,private readonly rows:z.infer<typeof PilotRowSchema>[]){ }
 fingerprint(){return createHash('sha256').update(`stage-1.5:${this.testCase.id}`).digest('hex').slice(0,16);}
 async buildContext(selected:Film[],language:Language){
  void language;const gold=this.rows.find(row=>row.id===this.testCase.recordId);if(!gold)throw new Error(`Missing pilot record: ${this.testCase.recordId}`);
  const seedTerms=new Set(this.testCase.seeds.map(seed=>normalize(seed.title))),related=this.rows.filter(row=>row.id!==gold.id&&row.confidence==='verified'&&row.entities.some(entity=>[...seedTerms].some(seed=>normalize(entity)===seed))).slice(0,5);
  const passages:ContextPassage[]=[gold,...related].map(row=>({id:`Q-${row.id}`,documentId:`D-${row.id}`,title:row.title,author:row.author_or_curator,publisher:row.publisher,url:row.url,
   type:row.type==='scholarship'?'academic':row.type==='programme'?'programme':'criticism',locator:'human-reviewed source paraphrase',excerpt:`${row.claim_paraphrase_ko} 경계: ${row.context_boundary}`.slice(0,900),
   filmIds:selected.filter(film=>row.entities.some(entity=>normalize(entity)===normalize(film.title))).map(film=>film.id),subjects:row.entities.slice(0,20),contentKind:'reviewed_paraphrase',reviewState:'human_checked',rights:'link_and_metadata_only'}));
  return ContextBundleSchema.parse({version:1,corpusVersion:'stage-1.5-reviewed-pilot-50',builtAt:'2026-09-20T00:00:00.000Z',selectedFilmIds:selected.map(film=>film.id).sort(),passages,legacyNotes:[]});
 }
}
async function callCurator(testCase:Case,selected:Film[],condition:Condition,repository:KnowledgeRepository,options:RelationRecallOptions):Promise<Run>{
 const started=Date.now();
 try{
  const result=await runCuratorV1({selected,excludedIds:[],language:'ko',repository,options:{model:options.model,reasoning:'none',timeoutMs:options.deadlineMs,maxOutputTokens:options.maxOutputTokens},signal:AbortSignal.timeout(options.deadlineMs+15_000)}),recommendations=result.decision.recommendations.map(rec=>({id:rec.film.id,t:rec.film.title,y:rec.film.year,d:rec.film.director,b:rec.connection,attribution:rec.attribution,evidenceIds:rec.evidenceIds})),rank=recommendations.findIndex(item=>titleMatches(item.t,testCase.target));
  return {caseId:testCase.id,caseClass:testCase.class,condition,ok:true,elapsedMs:result.timings.totalMs,model:result.model,timings:result.timings,usage:{inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,estimatedUsd:result.usage.estimatedUsd},lens:result.decision.lens,recommendations,targetRecovered:rank>=0,targetRank:rank>=0?rank+1:null,targetConnection:rank>=0?recommendations[rank].b:null};
 }catch(error){return {caseId:testCase.id,caseClass:testCase.class,condition,ok:false,elapsedMs:Date.now()-started,model:options.model,error:providerError(error)};}
}
async function mapLimit<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>){const results=new Array<R>(items.length);let next=0;async function worker(){while(next<items.length){const index=next++;results[index]=await fn(items[index]);}}await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return results;}
function percentile(values:number[],p:number){const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]:null;}
function summarize(runs:Run[],condition:Condition,caseClass?:Case['class']){
 const selected=runs.filter(run=>run.condition===condition&&(!caseClass||run.caseClass===caseClass)),success=selected.filter(run=>run.ok),latencies=success.map(run=>run.elapsedMs),recovered=success.filter(run=>run.targetRecovered).length;
 return {attempts:selected.length,successes:success.length,successRate:selected.length?success.length/selected.length:0,within10s:success.filter(run=>run.elapsedMs<=10_000).length,within10sRate:selected.length?success.filter(run=>run.elapsedMs<=10_000).length/selected.length:0,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95),goldRecovered:recovered,goldRecall:success.length?recovered/success.length:0,meanRecoveredRank:recovered?success.reduce((sum,run)=>sum+(run.targetRank??0),0)/recovered:null};
}
export async function diagnoseRelationRecall(options:RelationRecallOptions){
 const cases=CasesSchema.parse(JSON.parse(await readFile(resolve('research/curator/relation-recall-cases.json'),'utf8'))),rows=(await readFile(resolve('../outputs/strada-corpus-pilot/pilot-corpus.jsonl'),'utf8')).trim().split('\n').map(line=>PilotRowSchema.parse(JSON.parse(line)));
 const request={caseCount:cases.cases.length,callCount:cases.cases.length*CONDITIONS.length,conditions:CONDITIONS,model:options.model,reasoning:'none',deadlineMs:options.deadlineMs,maxOutputTokens:options.maxOutputTokens,concurrency:options.concurrency};
 if(!options.run)return {version:1,dryRun:true,request,message:'No API calls were made. Add --run to execute the experiment.'};
 if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is missing.');
 const uniqueSeeds=[...new Map(cases.cases.flatMap(testCase=>testCase.seeds).map(seed=>[`${normalize(seed.title)}:${seed.year}`,seed])).values()],resolvedSeeds=await resolveCandidates(uniqueSeeds,{remaining:200,signal:AbortSignal.timeout(30_000)});
 if(resolvedSeeds.some(film=>!film))throw new Error(`Seed identity resolution failed: ${uniqueSeeds.filter((_,index)=>!resolvedSeeds[index]).map(seed=>seed.title).join(', ')}`);
 const seedMap=new Map(uniqueSeeds.map((seed,index)=>[`${normalize(seed.title)}:${seed.year}`,resolvedSeeds[index]!])),snapshotRepository=new SnapshotKnowledgeRepository();
 const plan=cases.cases.flatMap(testCase=>CONDITIONS.map(condition=>({testCase,condition,selected:testCase.seeds.map(seed=>seedMap.get(`${normalize(seed.title)}:${seed.year}`)!),repository:condition==='bare'?new EmptyKnowledgeRepository():condition==='snapshot'?snapshotRepository:new DossierKnowledgeRepository(testCase,rows)})));
 const runs=await mapLimit(plan,options.concurrency,item=>callCurator(item.testCase,item.selected,item.condition,item.repository,options));
 const summary=Object.fromEntries(CONDITIONS.map(condition=>[condition,{all:summarize(runs,condition),sameDirector:summarize(runs,condition,'same_director'),crossDirector:summarize(runs,condition,'cross_director')}])) as Record<Condition,{all:ReturnType<typeof summarize>;sameDirector:ReturnType<typeof summarize>;crossDirector:ReturnType<typeof summarize>}>;
 const dossierLiftVsBare=summary.dossier.all.goldRecall-summary.bare.all.goldRecall,dossierLiftVsSnapshot=summary.dossier.all.goldRecall-summary.snapshot.all.goldRecall;
 const diagnosticThresholds={speed:{pass:summary.dossier.all.within10sRate>=.9,threshold:'dossier within-10s rate >= 0.90'},documentUse:{pass:summary.dossier.all.goldRecall>=.75&&dossierLiftVsSnapshot>=.2,threshold:'dossier relation recall >= 0.75 and lift vs snapshot >= 0.20'}};
 return {version:2,dryRun:false,createdAt:new Date().toISOString(),request,diagnosticMeaning:'This is a documented-relation recall diagnostic only. The target is deliberately present in the dossier, so recovery measures retrieval and use of a known relation. It is not a recommendation-quality score and cannot gate release.',summary,lifts:{dossierVsBare:dossierLiftVsBare,dossierVsSnapshot:dossierLiftVsSnapshot},diagnosticThresholds,runs,cases:cases.cases};
}

async function main(){
 try{
  nextEnv.loadEnvConfig(process.cwd());const options=parseRelationRecallOptions(process.argv.slice(2));if(options.help){console.log(HELP);return;}
  const target=resolve(options.out);if(options.run)try{await lstat(target);throw new Error('Output already exists.');}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
  const report=await diagnoseRelationRecall(options);if(!options.run){console.log(JSON.stringify(report,null,2));return;}
  await mkdir(dirname(target),{recursive:true});await writeFile(target,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({reportPath:target,summary:report.summary,lifts:report.lifts,diagnosticThresholds:report.diagnosticThresholds},null,2));
 }catch(error){console.error(`STRADA relation-recall diagnostic: ${providerError(error)}`);process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
