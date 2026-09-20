import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import nextEnv from '@next/env';
import {z} from 'zod';
import {FilmSchema,type Film,type Language} from '../lib/domain';
import {ContextBundleSchema} from '../lib/server/curator-v1/contract';
import {runCuratorV1} from '../lib/server/curator-v1/engine';
import type {KnowledgeRepository} from '../lib/server/knowledge/repository';
import {CorpusKnowledgeRepository} from '../lib/server/knowledge/corpus';

export const QUALITY_CONDITIONS=['baseline','candidate'] as const;
export type QualityCondition=typeof QUALITY_CONDITIONS[number];

export const QUALITY_RUBRIC={
 setReading:{labelKo:'입력 독해',questionKo:'입력 영화들에서 설득력 있는 큐레이션의 출발점을 찾았는가?',anchors:{1:'한 입력을 무시하거나 피상적인 공통점만 반복한다.',3:'입력 전체를 다루지만 몇몇 연결은 약하다.',5:'입력 전체를 정확히 읽고 기대하지 못한 탐색 가능성을 연다.'}},
 specificity:{labelKo:'연결의 구체성',questionKo:'각 영화가 왜 이 경로에 속하는지 구체적이고 유용하게 설명하는가?',anchors:{1:'거의 어느 영화에도 붙일 수 있는 일반론이다.',3:'구체적인 연결과 추상적인 연결이 섞여 있다.',5:'작품, 제작, 인물 또는 맥락의 정확한 관계가 각 선택을 설득한다.'}},
 discoveryValue:{labelKo:'발견 가치',questionKo:'익숙한 선택과 낯선 선택을 가리지 않고 실제 탐색을 진전시키는가?',anchors:{1:'예상 가능한 작품을 반복하거나 관련성이 약하다.',3:'유용한 선택과 자리를 채운 선택이 섞여 있다.',5:'각 선택이 다음 영화를 볼 분명한 이유를 준다.'}},
 curatorialJudgment:{labelKo:'큐레이션 판단',questionKo:'가능한 수많은 연결 중 이 12편을 고른 판단이 뛰어난가?',anchors:{1:'자동 유사도 목록처럼 보이고 선택의 우선순위가 없다.',3:'강한 선택이 있으나 일부는 더 나은 선택으로 교체할 수 있다.',5:'단순한 제작 연결부터 복잡한 해석까지 가장 유효한 연결을 정확히 골랐다.'}},
 listComposition:{labelKo:'목록 구성',questionKo:'12편이 하나의 유용한 프로그램으로 작동하는가?',anchors:{1:'반복이 새 정보를 만들지 못하고 여러 자리가 낭비된다.',3:'좋은 항목이 있지만 일부가 겹치거나 순서가 느슨하다.',5:'반복을 포함한 모든 선택이 경로를 더 깊게 하며 각 자리가 필요하다.'}},
 trustworthiness:{labelKo:'신뢰성',questionKo:'사실과 관계의 강도를 정직하고 정확하게 다루는가?',anchors:{1:'중대한 사실 오류나 꾸며낸 영향 관계가 있다.',3:'대체로 정확하지만 일부 과장이나 불명확한 귀속이 있다.',5:'사실 관계가 정확하고 추측을 확정된 사실처럼 과장하지 않는다.'}},
} as const;
export const QUALITY_AXIS_KEYS=Object.keys(QUALITY_RUBRIC) as (keyof typeof QUALITY_RUBRIC)[];

const HELP=`STRADA curator_v1 blind recommendation-quality evaluation (no API calls unless --run)

npm run evaluate:curator-v1-quality -- --run --case all --repeat 1 --out work/curator-v1-quality.json

--case ID,ID|all      No-gold cases from research/curator/eval-cases.json. Default: all
--model MODEL          Default: gpt-5.6-terra. Sol is rejected.
--repeat N             One or two independent runs per case/condition. Default: 1
--deadline-ms N        End-to-end deadline. Default: 20000
--max-output-tokens N  Output plus reasoning budget. Default: 2000
--concurrency N        One to four simultaneous calls. Default: 1
--language ko|en       Default: ko
--out FILE.json        Report path. Default: work/curator-v1-quality.json
--run                  Permit real API calls and charges
--help                 Show this help

The release-quality decision is made only from completed blind human ratings.
No expected recommendation titles or LLM-judge votes are used as a quality gate.
`;

const CasesSchema=z.object({version:z.literal(1),cases:z.array(z.object({id:z.string(),label:z.string(),selected:z.array(FilmSchema).min(1).max(8)})).min(1)});
export type QualityCase=z.infer<typeof CasesSchema>['cases'][number];
export type QualityRecommendation={id:string;title:string;titleKo?:string;year:number;director:string;connection:string;anchorIds:string[];attribution:string;evidenceIds:string[]};
export type QualityRun={caseId:string;repetition:number;condition:QualityCondition;ok:boolean;elapsedMs:number;model:string;timings?:{contextMs:number;modelMs:number;resolveMs:number;repairMs:number;totalMs:number};usage?:{inputTokens:number;outputTokens:number;estimatedUsd:number};repair?:{attempted:boolean;model?:string;indexes?:number[]};lens?:string;recommendations?:QualityRecommendation[];error?:string;errorDetails?:unknown};

export type QualityOptions={run:boolean;help:boolean;caseIds:string[]|'all';model:string;repeat:number;deadlineMs:number;maxOutputTokens:number;concurrency:number;language:Language;out:string};
export function parseQualityOptions(argv:string[]):QualityOptions{
 const values:Record<string,string>={},switches=new Set<string>();
 for(let i=0;i<argv.length;i++){
  if(!argv[i].startsWith('--'))throw new Error('Use named options; see --help.');
  const name=argv[i].slice(2);
  if(name==='run'||name==='help'){switches.add(name);continue;}
  if(!['case','model','repeat','deadline-ms','max-output-tokens','concurrency','language','out'].includes(name)||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Unknown option or missing value; see --help.');
  values[name]=argv[++i];
 }
 const caseValue=values.case??'all',caseIds=caseValue==='all'?'all':caseValue.split(',').map(value=>value.trim()).filter(Boolean);
 if(caseIds!=='all'&&(!caseIds.length||new Set(caseIds).size!==caseIds.length))throw new Error('Choose one or more distinct case IDs, or all.');
 const model=values.model??'gpt-5.6-terra';if(/(?:^|[-_.])sol(?:$|[-_.])/i.test(model))throw new Error('Sol is excluded from this experiment.');
 const repeat=Number(values.repeat??1);if(!Number.isInteger(repeat)||repeat<1||repeat>2)throw new Error('--repeat must be 1 or 2.');
 const deadlineMs=Number(values['deadline-ms']??20000);if(!Number.isInteger(deadlineMs)||deadlineMs<1000||deadlineMs>60000)throw new Error('--deadline-ms must be 1000–60000.');
 const maxOutputTokens=Number(values['max-output-tokens']??2000);if(!Number.isInteger(maxOutputTokens)||maxOutputTokens<700||maxOutputTokens>4000)throw new Error('--max-output-tokens must be 700–4000.');
 const concurrency=Number(values.concurrency??1);if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('--concurrency must be 1–4.');
 const language=values.language??'ko';if(language!=='ko'&&language!=='en')throw new Error('--language must be ko or en.');
 const out=values.out??'work/curator-v1-quality.json';if(!out.endsWith('.json'))throw new Error('--out must be a .json file.');
 return {run:switches.has('run'),help:switches.has('help'),caseIds,model,repeat,deadlineMs,maxOutputTokens,concurrency,language,out};
}

class EmptyKnowledgeRepository implements KnowledgeRepository{
 fingerprint(){return 'quality-baseline-empty';}
 async buildContext(selected:Film[],language:Language){
  void language;
  return ContextBundleSchema.parse({version:1,corpusVersion:'quality-baseline-empty',builtAt:'2026-09-20T00:00:00.000Z',selectedFilmIds:selected.map(film=>film.id).sort(),passages:[],legacyNotes:[]});
 }
}

const providerError=(error:unknown)=>error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:error instanceof DOMException&&['TimeoutError','AbortError'].includes(error.name)?'TIMEOUT':error instanceof Error?error.message:'EVALUATION_FAILED';
const providerErrorDetails=(error:unknown)=>error&&typeof error==='object'&&'details'in error?error.details:undefined;
const comparisonId=(caseId:string,repetition:number)=>`${caseId}::${repetition}`;

export function blindOrder(caseId:string,repetition=1):QualityCondition[]{
 return [...QUALITY_CONDITIONS].sort((a,b)=>createHash('sha256').update(`strada-quality-v2:${caseId}:${repetition}:${a}`).digest('hex').localeCompare(createHash('sha256').update(`strada-quality-v2:${caseId}:${repetition}:${b}`).digest('hex')));
}

async function callCurator(testCase:QualityCase,repetition:number,condition:QualityCondition,repository:KnowledgeRepository,options:QualityOptions):Promise<QualityRun>{
 const started=Date.now();
 try{
  const result=await runCuratorV1({selected:testCase.selected,excludedIds:[],language:options.language,repository,options:{model:options.model,reasoning:'none',timeoutMs:Math.max(1000,options.deadlineMs-4250),maxOutputTokens:options.maxOutputTokens,promptVersion:'v2',repair:{model:'gpt-5.4',timeoutMs:3750,maxOutputTokens:1100}},signal:AbortSignal.timeout(options.deadlineMs)});
  const recommendations=result.decision.recommendations.map(rec=>({id:rec.film.id,title:rec.film.title,titleKo:rec.film.titleKo,year:rec.film.year,director:rec.film.director,connection:rec.connection,anchorIds:rec.anchorIds,attribution:rec.attribution,evidenceIds:rec.evidenceIds}));
  return {caseId:testCase.id,repetition,condition,ok:true,elapsedMs:result.timings.totalMs,model:result.model,timings:result.timings,usage:{inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,estimatedUsd:result.usage.estimatedUsd},repair:result.repair,lens:result.decision.lens,recommendations};
 }catch(error){return {caseId:testCase.id,repetition,condition,ok:false,elapsedMs:Date.now()-started,model:options.model,error:providerError(error),errorDetails:providerErrorDetails(error)};}
}

async function mapLimit<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>){
 const results=new Array<R>(items.length);let next=0;
 async function worker(){while(next<items.length){const index=next++;results[index]=await fn(items[index]);}}
 await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return results;
}
function percentile(values:number[],p:number){const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)]:null;}
function summarize(runs:QualityRun[],condition:QualityCondition){
 const selected=runs.filter(run=>run.condition===condition),success=selected.filter(run=>run.ok),latencies=success.map(run=>run.elapsedMs);
 return {attempts:selected.length,successes:success.length,successRate:selected.length?success.length/selected.length:0,within20s:success.filter(run=>run.elapsedMs<=20_000).length,within20sRate:selected.length?success.filter(run=>run.elapsedMs<=20_000).length/selected.length:0,p50Ms:percentile(latencies,.5),p95Ms:percentile(latencies,.95)};
}

function listLabels(testCase:QualityCase,repetition:number,runs:QualityRun[]){
 return blindOrder(testCase.id,repetition).map((condition,index)=>({label:index===0?'A':'B',condition,run:runs.find(item=>item.caseId===testCase.id&&item.repetition===repetition&&item.condition===condition)}));
}
function anchorNames(testCase:QualityCase,recommendation:QualityRecommendation){
 const byId=new Map(testCase.selected.map(film=>[film.id,film.title]));
 return recommendation.anchorIds.map(id=>byId.get(id)).filter((title):title is string=>Boolean(title));
}

export function renderHumanPacket(packetId:string,cases:QualityCase[],repeat:number,runs:QualityRun[],includeConnections=true){
 const view=includeConnections?'완성품':'선정작만';
 const lines=[`# STRADA 블라인드 추천 품질 평가 — ${view}`,'',`패킷 ID: \`${packetId}\``,'','A와 B는 같은 메인 모델, 출력 수, 시간 제한, 작품 식별·복구 정책을 사용했습니다. 조건의 정체, 지연시간, 비용은 가렸습니다. 정답 영화는 없습니다. 각 목록을 먼저 독립적으로 평가한 뒤 마지막에 A/B/실질적 동률을 선택하세요.','','후보를 모른다는 이유만으로 낮은 점수를 주지 말고, 입력 영화에 대한 지식이 부족하면 평가 템플릿의 친숙도에 표시하세요. 실행 실패도 실제 사용자 경험이므로 그대로 표시됩니다.',''];
 if(includeConnections){
  lines.push('## 1–5점 rubric','');
  for(const axis of QUALITY_AXIS_KEYS){const item=QUALITY_RUBRIC[axis];lines.push(`- **${item.labelKo}** — ${item.questionKo} 1: ${item.anchors[1]} / 3: ${item.anchors[3]} / 5: ${item.anchors[5]}`);}
  lines.push('');
 }
 for(const testCase of cases)for(let repetition=1;repetition<=repeat;repetition++){
  lines.push(`## ${testCase.id} · 실행 ${repetition}`,'',`입력: ${testCase.selected.map(film=>`*${film.title}* (${film.year}, ${film.director})`).join(' + ')}`,'');
  for(const {label,run} of listLabels(testCase,repetition,runs)){
   lines.push(`### 목록 ${label}`,'');
   if(!run?.ok||!run.recommendations){lines.push('정상적인 12편 목록을 생성하지 못했습니다.','');continue;}
   if(includeConnections)lines.push(`관점: ${run.lens}`,'');
   run.recommendations.forEach((rec,rank)=>{
    const title=`${rank+1}. *${rec.title}* (${rec.year}, ${rec.director})`;
    if(!includeConnections){lines.push(title);return;}
    const anchors=anchorNames(testCase,rec),scope=anchors.length?` [관련 입력: ${anchors.join(', ')}]`:'';
    lines.push(`${title} — ${rec.connection}${scope}`);
   });
   lines.push('');
  }
  lines.push('먼저 A와 B를 각각 평가한 뒤 선택: A [ ] / B [ ] / 실질적 동률 [ ]','','---','');
 }
 return lines.join('\n');
}

const emptyAxes=()=>Object.fromEntries(QUALITY_AXIS_KEYS.map(axis=>[axis,null]));
const emptyItems=()=>Array.from({length:12},(_,index)=>({rank:index+1,verdict:null as null|'strong'|'useful'|'weak'|'reject'|'unrated',notes:''}));
export function createHumanRatingTemplate(packetId:string,cases:QualityCase[],repeat:number){
 return {version:2,packetId,evaluatorType:'human',reviewerId:'',instructions:'Score each list independently before choosing A, B, or tie. Complete all six axes. LLM-generated ratings are not valid for the release gate.',rubric:QUALITY_RUBRIC,cases:cases.flatMap(testCase=>Array.from({length:repeat},(_,index)=>({comparisonId:comparisonId(testCase.id,index+1),caseId:testCase.id,repetition:index+1,seedFamiliarity:null as null|1|2|3|4|5,ratings:Object.fromEntries(['A','B'].map(label=>[label,{axes:emptyAxes(),overallUsefulness:null as number|null,items:emptyItems(),criticalErrors:[] as string[],notes:''}])),preferred:null as null|'A'|'B'|'tie',confidence:null as number|null,pairwiseRationale:''})))};
}

export async function evaluateQuality(options:QualityOptions){
 const parsed=CasesSchema.parse(JSON.parse(await readFile(resolve('research/curator/eval-cases.json'),'utf8')));
 const cases=options.caseIds==='all'?parsed.cases:options.caseIds.map(id=>{const testCase=parsed.cases.find(item=>item.id===id);if(!testCase)throw new Error(`Unknown case: ${id}`);return testCase;});
 const request={caseCount:cases.length,callCount:cases.length*QUALITY_CONDITIONS.length*options.repeat,conditions:QUALITY_CONDITIONS,caseIds:cases.map(item=>item.id),model:options.model,promptVersion:'v2' as const,reasoning:'none' as const,repeat:options.repeat,deadlineMs:options.deadlineMs,maxOutputTokens:options.maxOutputTokens,concurrency:options.concurrency,language:options.language};
 const evaluationPolicy={qualityDefinition:'Blind human preference and six-axis listwise quality; there is no expected recommendation list.',primaryDecision:'At least three independent human reviewers score each list before making a pairwise choice.',llmJudge:{allowedUse:'development proxy and disagreement triage only',gating:false,status:'not_run'},releaseStatus:'pending_human_review'} as const;
 if(!options.run)return {version:2,dryRun:true,request,evaluationPolicy,message:'No API calls were made. Add --run to create the A/B human-review packet.'};
 if(!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is missing.');
 const repositories:Record<QualityCondition,KnowledgeRepository>={baseline:new EmptyKnowledgeRepository(),candidate:new CorpusKnowledgeRepository()};
 const plan=cases.flatMap(testCase=>Array.from({length:options.repeat},(_,index)=>index+1).flatMap(repetition=>QUALITY_CONDITIONS.map(condition=>({testCase,repetition,condition,repository:repositories[condition]}))));
 const runs=await mapLimit(plan,options.concurrency,item=>callCurator(item.testCase,item.repetition,item.condition,item.repository,options));
 const summary=Object.fromEntries(QUALITY_CONDITIONS.map(condition=>[condition,summarize(runs,condition)])) as Record<QualityCondition,ReturnType<typeof summarize>>;
 const blindConditionMap=Object.fromEntries(cases.flatMap(testCase=>Array.from({length:options.repeat},(_,index)=>index+1).map(repetition=>[comparisonId(testCase.id,repetition),Object.fromEntries(blindOrder(testCase.id,repetition).map((condition,index)=>[index===0?'A':'B',condition]))])));
 const packetId=createHash('sha256').update(JSON.stringify({request,runs:runs.map(run=>({caseId:run.caseId,repetition:run.repetition,condition:run.condition,ok:run.ok,elapsedMs:run.elapsedMs,lens:run.lens,recommendations:run.recommendations}))})).digest('hex').slice(0,24);
 return {version:2,dryRun:false,createdAt:new Date().toISOString(),packetId,request,evaluationPolicy,rubric:QUALITY_RUBRIC,summary,operationalTarget:{within20sRate:.95,note:'This run reports the measurement. A release claim requires at least 200 end-to-end attempts with failures in the denominator.'},humanQualityGate:{status:'pending_human_review',minimumIndependentReviewers:3,minimumHoldoutCases:40,pairwiseCandidateScore:.60,pairwiseWilsonLowerBound:.50,meanOverallUsefulness:4,meanWorthwhileItems:8,criticalErrors:0},blindConditionMap,runs,cases};
}

async function main(){
 try{
  nextEnv.loadEnvConfig(process.cwd());const options=parseQualityOptions(process.argv.slice(2));if(options.help){console.log(HELP);return;}
  const target=resolve(options.out);if(options.run)try{await lstat(target);throw new Error('Output already exists.');}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
  const report=await evaluateQuality(options);if(!options.run){console.log(JSON.stringify(report,null,2));return;}
  await mkdir(dirname(target),{recursive:true});await writeFile(target,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  const typed=report as Awaited<ReturnType<typeof evaluateQuality>>&{dryRun:false;packetId:string;runs:QualityRun[];cases:QualityCase[]};
  const base=target.replace(/\.json$/,'');
  const selectionPacket=`${base}-blind-selection.md`,fullPacket=`${base}-blind-full.md`,ratingsTemplate=`${base}-human-ratings.json`;
  await writeFile(selectionPacket,renderHumanPacket(typed.packetId,typed.cases,options.repeat,typed.runs,false),'utf8');
  await writeFile(fullPacket,renderHumanPacket(typed.packetId,typed.cases,options.repeat,typed.runs,true),'utf8');
  await writeFile(ratingsTemplate,JSON.stringify(createHumanRatingTemplate(typed.packetId,typed.cases,options.repeat),null,2)+'\n','utf8');
  console.log(JSON.stringify({reportPath:target,selectionPacket,fullPacket,ratingsTemplate,summary:typed.summary,releaseStatus:typed.evaluationPolicy.releaseStatus},null,2));
 }catch(error){console.error(`STRADA blind quality evaluation: ${providerError(error)}`);process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void main();
