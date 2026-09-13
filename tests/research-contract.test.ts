import test from 'node:test';
import assert from 'node:assert/strict';
import {PlanCandidate,PlanEnvelope,ExplanationOutput,ExplanationEnvelope,SourceNote,parseResearchOutput,recommendationPlanSchema,recommendationExplanationSchema} from '../lib/research-contract';

const list=(n:number,prefix:string)=>Array.from({length:n},(_,i)=>`${prefix}${i}`);
function enumCount(value:unknown):number{
 if(!value||typeof value!=='object')return 0;
 const record=value as Record<string,unknown>;
 return (Array.isArray(record.enum)?record.enum.length:0)+Object.entries(record).filter(([key])=>key!=='enum').reduce((total,[,child])=>total+enumCount(child),0);
}
function verifyRefs(value:unknown,root:Record<string,any>){
 if(!value||typeof value!=='object')return;
 const record=value as Record<string,unknown>;
 if(typeof record.$ref==='string'){
  const path=record.$ref.split('/').slice(1);let target:any=root;
  for(const key of path)target=target?.[key];
  assert.ok(target,`Unresolved reference ${record.$ref}`);
 }
 if(record.type==='object'){
  assert.equal(record.additionalProperties,false);
  assert.deepEqual(record.required,Object.keys(record.properties as object));
 }
 for(const child of Object.values(record))verifyRefs(child,root);
}

test('planning keeps every allowed anchor and all historical codes under the API enum limit',()=>{
 // Include the difficult middle-length case that formerly repeated every enum in each anchor group.
 for(const count of [1,8,16,38]){
  const anchors=list(count,'a'),sources=list(16,'s'),history=list(438,'d');
  const schema=recommendationPlanSchema(anchors,sources,history);
  assert.deepEqual(schema.$defs.anchor.enum,anchors);
  assert.deepEqual(schema.$defs.discovery.enum,history);
  assert.deepEqual(schema.$defs.source.enum,sources);
  assert.equal(enumCount(schema),count+16+438);
  assert.ok(enumCount(schema)<=1000);
  verifyRefs(schema,schema);
  assert.equal(JSON.stringify(schema).includes('minLength'),false);
 }
 const schema:any=recommendationPlanSchema(['a0'],[],['d0']);
 assert.equal(schema.properties.candidates.minItems,24);
 assert.equal(schema.properties.candidates.maxItems,24);
 assert.equal(schema.properties.explorations.minItems,0);
 assert.equal(schema.properties.explorations.maxItems,0);
 assert.equal(schema.$defs.connection.properties.evidence.maxItems,0);
 assert.equal(schema.$defs.candidate.properties.discoveryBasis.minItems,1);
});

test('supplied sources require 12 evidence-based candidates before 12 source-free reserves',()=>{
 const schema:any=recommendationPlanSchema(['a0','a1'],['s0','s1'],['d0','d1']);
 assert.deepEqual(schema.required,['candidates','explorations']);
 assert.equal(schema.properties.candidates.minItems,12);
 assert.equal(schema.properties.candidates.maxItems,12);
 assert.equal(schema.properties.explorations.minItems,12);
 assert.equal(schema.properties.explorations.maxItems,12);
 assert.equal(schema.properties.candidates.items.$ref,'#/$defs/candidate');
 assert.equal(schema.properties.explorations.items.$ref,'#/$defs/exploration');
 assert.equal(schema.$defs.candidate.properties.connections.items.$ref,'#/$defs/connection');
 assert.equal(schema.$defs.connection.properties.evidence.minItems,1);
 assert.equal(schema.$defs.connection.properties.evidence.maxItems,2);
 assert.equal(schema.$defs.exploration.properties.connections.items.$ref,'#/$defs/explorationConnection');
 assert.equal(schema.$defs.explorationConnection.properties.evidence.maxItems,0);
 verifyRefs(schema,schema);
});

test('the plan envelope preserves critical candidates before AI reserves without changing its consumer',()=>{
 const candidates=Array.from({length:12},(_,i)=>({title:`Sourced ${i}`}));
 const explorations=Array.from({length:12},(_,i)=>({title:`Exploration ${i}`}));
 assert.deepEqual(PlanEnvelope.parse({candidates,explorations}),{candidates:[...candidates,...explorations]});
 assert.deepEqual(PlanEnvelope.parse({candidates}),{candidates});
 assert.equal(PlanEnvelope.safeParse({candidates,explorations:[...explorations,{}]}).success,false);
});

test('a malformed identity is rejected individually without losing a valid planned film',()=>{
 const valid={title:'Boyhood',year:2014,director:'Richard Linklater',rationale:'A shared concern with ordinary life unfolding over time.',discoveryBasis:['d0','d1'],connections:[{anchor:'a0',reason:'Time and everyday gestures.',reasonKo:'시간과 일상의 몸짓.',evidence:[{ref:'s0'}]}]};
 const envelope=PlanEnvelope.parse({candidates:[{...valid,year:'unknown'},valid]});
 const parsed=envelope.candidates.map(row=>PlanCandidate.safeParse(row)).filter(row=>row.success);
 assert.equal(parsed.length,1);
 assert.equal(PlanCandidate.parse({...valid,rationale:'x'.repeat(601)}).rationale.length,600);
 assert.equal(PlanCandidate.parse({...valid,connections:[{...valid.connections[0],reasonKo:{}}]}).connections[0].reasonKo,'');
 assert.equal(PlanEnvelope.safeParse({candidates:Array.from({length:25},()=>valid)}).success,false);
});

test('one malformed locale or optional note field does not discard readable explanations',()=>{
 const envelope=ExplanationEnvelope.parse({explanations:{r0:{paragraphs:[{en:'The films on this path use everyday rituals to reveal family tensions.',ko:{}}]}},sourceNotes:{}});
 assert.deepEqual(envelope.sourceNotes,[]);
 const explanation=ExplanationOutput.parse(envelope.explanations.r0);
 assert.equal(explanation.paragraphs[0].en,'The films on this path use everyday rituals to reveal family tensions.');
 assert.equal(explanation.paragraphs[0].ko,'');
 assert.equal(ExplanationOutput.safeParse({paragraphs:[{en:{},ko:null}]}).success,false);
 assert.deepEqual(PlanEnvelope.parse({candidates:[{title:'A verified identity'}],explorations:null}).candidates,[{title:'A verified identity'}]);
});

test('a token-limited plan retains complete sourced identities before complete reserves',()=>{
 const sourced={title:'Good Morning',year:1959,director:'Yasujiro Ozu',rationale:'A \\"quoted\\" observation, with {braces} and [brackets].',discoveryBasis:['d0','d1'],connections:[{anchor:'a0',reason:'Everyday family rituals.',reasonKo:'가족의 일상.',evidence:[{ref:'s0'}]}]};
 const reserve={...sourced,title:'Late Spring',year:1949,connections:[{...sourced.connections[0],evidence:[]}]};
 const raw=`{"candidates":[${JSON.stringify(sourced)}],"explorations":[${JSON.stringify(reserve)},{"title":"Unfinished`;
 const parsed=PlanEnvelope.parse(parseResearchOutput(raw,'plan'));
 assert.deepEqual(parsed.candidates,[sourced,reserve]);
 assert.equal(parsed.candidates.map(row=>PlanCandidate.safeParse(row)).every(row=>row.success),true);
 assert.equal(parseResearchOutput('{"candidates":[{"title":"Unfinished','plan'),null);
});

test('a token-limited explanation never completes the unfinished film or source note',()=>{
 const complete={paragraphs:[{en:'The films on this path turn quiet routines into a study of social change.',ko:'경로에서 만난 영화들은 조용한 일상을 통해 사회 변화를 살핍니다.'}]};
 const raw=`{"explanations":{"r0":${JSON.stringify(complete)},"r1":{"paragraphs":[{"en":"Not finished`;
 const parsed=ExplanationEnvelope.parse(parseResearchOutput(raw,'explanation'));
 assert.deepEqual(parsed.explanations,{r0:complete});
 assert.deepEqual(parsed.sourceNotes,[]);
 const truncatedNotes=`{"explanations":{"r0":${JSON.stringify(complete)}},"sourceNotes":[{"ref":"s0","summary":"unfinished`;
 assert.deepEqual(ExplanationEnvelope.parse(parseResearchOutput(truncatedNotes,'explanation')).sourceNotes,[]);
 assert.deepEqual(parseResearchOutput('```json\n'+JSON.stringify({explanations:{r0:complete},sourceNotes:[]})+'\n```','explanation'),{explanations:{r0:complete},sourceNotes:[]});
});

test('explanations require exact verified IDs and share a single three-paragraph schema',()=>{
 const ids=list(12,'r'),schema:any=recommendationExplanationSchema(ids,list(16,'s'));
 assert.deepEqual(schema.properties.explanations.required,ids);
 assert.equal(schema.properties.explanations.additionalProperties,false);
 assert.ok(Object.values(schema.properties.explanations.properties).every((item:any)=>item.$ref==='#/$defs/explanation'));
 assert.equal(schema.$defs.explanation.properties.paragraphs.minItems,3);
 assert.equal(schema.$defs.explanation.properties.paragraphs.maxItems,3);
 assert.equal(enumCount(schema),16);
 verifyRefs(schema,schema);
 assert.equal(JSON.stringify(schema).includes('minLength'),false);
 const sourceFree:any=recommendationExplanationSchema(['r0'],[]);
 assert.equal(sourceFree.properties.sourceNotes.maxItems,0);
});

test('explanation and source-note prose keep serialization fragments out of display text',()=>{
 const broken='The films on this path explore time and memory.” },“inferenceWhyKo”:{ } , ,';
 const envelope=ExplanationEnvelope.parse({explanations:{r0:{paragraphs:[{en:broken,ko:'시간과 기억을 탐색합니다.'}]},r1:{paragraphs:'malformed'}},sourceNotes:[]});
 const explanation=ExplanationOutput.parse(envelope.explanations.r0);
 assert.equal(explanation.paragraphs[0].en,'The films on this path explore time and memory.');
 assert.equal(ExplanationOutput.safeParse(envelope.explanations.r1).success,false);
 const note=SourceNote.parse({ref:'s0',summary:broken,summaryKo:'시간과 기억을 다룹니다.',passage:'A copied passage from the supplied source text.'});
 assert.equal(note.summary,'The films on this path explore time and memory.');
});
