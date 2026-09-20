import assert from 'node:assert/strict';
import test from 'node:test';
import {QUALITY_AXIS_KEYS,blindOrder,createHumanRatingTemplate,evaluateQuality,parseQualityOptions,renderHumanPacket,type QualityCase,type QualityRun} from '../scripts/evaluate-curator-v1-quality';
import {parseScoreOptions,scoreHumanRatings} from '../scripts/score-curator-v1-quality';

const qualityCase:QualityCase={id:'two-films',label:'Seed One + Seed Two',selected:[
 {id:'seed:1',title:'Seed One',year:1960,director:'Director One',poster:''},
 {id:'seed:2',title:'Seed Two',year:1980,director:'Director Two',poster:''},
]};
const recommendations=(prefix:string)=>Array.from({length:12},(_,index)=>({id:`${prefix}:${index}`,title:`${prefix} Film ${index+1}`,year:1950+index,director:`Director ${index+1}`,connection:`Specific connection ${index+1}`,anchorIds:index%2?['seed:1']:['seed:1','seed:2'],attribution:'model_proposal',evidenceIds:[]}));
const runs:QualityRun[]=[
 {caseId:qualityCase.id,repetition:1,condition:'baseline',ok:true,elapsedMs:100,model:'fixture',lens:'First lens',recommendations:recommendations('Alpha')},
 {caseId:qualityCase.id,repetition:1,condition:'candidate',ok:true,elapsedMs:100,model:'fixture',lens:'Second lens',recommendations:recommendations('Bravo')},
];

test('quality evaluator is dry by default and fixes both conditions to prompt v2',async()=>{
 const options=parseQualityOptions([]);assert.equal(options.run,false);assert.equal(options.model,'gpt-5.6-terra');assert.equal(options.repeat,1);assert.equal(options.deadlineMs,20000);assert.equal(options.maxOutputTokens,2000);assert.equal(options.concurrency,1);assert.equal(options.caseIds,'all');
 const report=await evaluateQuality({...options,caseIds:['closeup']});assert.equal(report.request.promptVersion,'v2');assert.deepEqual(report.request.conditions,['baseline','candidate']);
 assert.throws(()=>parseQualityOptions(['--model','gpt-5.6-sol']),/Sol is excluded/);
 assert.throws(()=>parseQualityOptions(['--repeat','3']),/1 or 2/);
});

test('A/B labels contain both conditions exactly once and are deterministic',()=>{
 const first=blindOrder('two-films',1),second=blindOrder('two-films',1);assert.deepEqual(first,second);assert.deepEqual([...first].sort(),['baseline','candidate']);
});

test('human export is no-gold, condition-blind, and uses all six quality axes',()=>{
 const template=createHumanRatingTemplate('packet-1',[qualityCase],1),packet=renderHumanPacket('packet-1',[qualityCase],1,runs,true);
 assert.equal(QUALITY_AXIS_KEYS.length,6);assert.deepEqual(Object.keys(template.cases[0].ratings.A.axes).sort(),[...QUALITY_AXIS_KEYS].sort());
 assert.equal(template.cases[0].ratings.A.items.length,12);assert.equal(template.cases[0].preferred,null);
 assert.match(packet,/목록 A/);assert.match(packet,/목록 B/);assert.match(packet,/입력 독해/);assert.match(packet,/큐레이션 판단/);assert.match(packet,/Alpha Film|Bravo Film/);
 assert.doesNotMatch(packet,/baseline|candidate|target|gold/i);assert.equal('target' in template.cases[0],false);
});

test('human scorer rejects proxy packets and leaves a small pilot incomplete',()=>{
 const map=Object.fromEntries(blindOrder(qualityCase.id,1).map((condition,index)=>[index===0?'A':'B',condition])) as {A:'baseline'|'candidate';B:'baseline'|'candidate'};
 const report={version:2,packetId:'packet-1',blindConditionMap:{'two-films::1':map}};
 const candidateLabel=map.A==='candidate'?'A':'B',axes=Object.fromEntries(QUALITY_AXIS_KEYS.map(axis=>[axis,5])),items=Array.from({length:12},(_,index)=>({rank:index+1,verdict:'strong',notes:''}));
 const rating=(reviewerId:string,evaluatorType='human')=>({version:2,packetId:'packet-1',evaluatorType,reviewerId,cases:[{comparisonId:'two-films::1',caseId:'two-films',repetition:1,seedFamiliarity:5,ratings:{A:{axes,overallUsefulness:5,items,criticalErrors:[],notes:''},B:{axes,overallUsefulness:5,items,criticalErrors:[],notes:''}},preferred:candidateLabel,confidence:5,pairwiseRationale:'Candidate is more coherent.'}]});
 const score=scoreHumanRatings(report,[rating('one'),rating('two'),rating('three')]);assert.equal(score.pairwise.candidateScore,1);assert.equal(score.gate.status,'incomplete');assert.equal(score.gate.checks.holdoutCases,false);assert.equal(score.judgePolicy.llmJudge.gating,false);
 assert.throws(()=>scoreHumanRatings(report,[rating('one','llm'),rating('two'),rating('three')]),/Invalid literal value|expected.*human/i);
 assert.throws(()=>parseScoreOptions(['--report','report.json','--ratings','one.json,two.json']),/At least three/);
});
