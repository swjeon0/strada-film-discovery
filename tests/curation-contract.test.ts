import test from 'node:test';
import assert from 'node:assert/strict';
import {
 CuratorialCandidate,CuratedFilm,CurationSchema,DetailSchema,DraftSchema,EvidenceNote,
 curationDraftSchema,curationSelectionSchema,detailOutputSchema,parseCurationOutput,
} from '../lib/curation-contract';

type JsonNode=Record<string,any>;
const list=(count:number,prefix:string)=>Array.from({length:count},(_,i)=>`${prefix}${i}`);
function verifySchema(value:unknown,root:JsonNode):number{
 if(!value||typeof value!=='object')return 0;
 const node=value as JsonNode;
 if(typeof node.$ref==='string'){
  const target=node.$ref.split('/').slice(1).reduce((current:JsonNode|undefined,key:string)=>current?.[key],root);
  assert.ok(target,`Unresolved schema reference ${node.$ref}`);
 }
 if(node.type==='object'){
  assert.equal(node.additionalProperties,false);
  assert.deepEqual(node.required,Object.keys(node.properties));
 }
 if(node.type==='array')assert.ok(node.minItems<=node.maxItems,'Array bounds are satisfiable.');
 return (Array.isArray(node.enum)?node.enum.length:0)+Object.entries(node).filter(([key])=>key!=='enum').reduce((sum,[,child])=>sum+verifySchema(child,root),0);
}

const lens={id:'l1',label:'Material time',question:'How can duration resist a purely narrative reading?',anchors:['a0','a1']};
const candidate={title:'Late Spring',year:1949,director:'Yasujiro Ozu',lens:'l1',anchors:['a0','a1'],bridge:'A provisional formal connection, with {braces}, [brackets], and an escaped "quotation".',contrast:'A different relationship between narrative and duration.',check:'Verify the formal premise before presenting it as fact.'};
const curated={candidate:'c0',lens:'Material time',anchors:['a0','a1'],why:'A proposed reading across these named films.',bridge:'A precise relationship.',contrast:'A productive difference.',evidence:[]};

test('draft schema shares valid references and bounded enums for one through 38 selected films',()=>{
 for(const count of [1,8,16,38]){
  const anchors=list(count,'a'),schema=curationDraftSchema(anchors) as JsonNode;
  assert.deepEqual(schema.$defs.anchor.enum,anchors);
  assert.deepEqual(schema.$defs.lensCode.enum,['l1','l2','l3']);
  assert.equal(verifySchema(schema,schema),count+6);
  assert.ok(verifySchema(schema,schema)<1000);
  assert.equal(schema.properties.candidates.minItems,24);
  assert.equal(schema.properties.candidates.maxItems,24);
  assert.equal(schema.properties.queries.maxItems,6);
  assert.equal(schema.$defs.candidate.properties.anchors.maxItems,Math.min(4,count));
 }
});

test('selection schema constrains identities to verified candidates and leaves source-free evidence empty',()=>{
 for(const count of [1,5,12,24,32]){
  const candidates=list(count,'c'),anchors=list(38,'a'),schema=curationSelectionSchema(candidates,anchors,[]) as JsonNode;
  assert.deepEqual(schema.$defs.candidate.enum,candidates);
  assert.equal(verifySchema(schema,schema),count+38+1);
  assert.equal(schema.properties.recommendations.minItems,Math.min(12,count));
  assert.equal(schema.properties.recommendations.maxItems,Math.min(12,count));
  assert.equal(Object.keys(schema.properties)[0],'readings');
  assert.equal(schema.properties.readings.minItems,0);
  assert.equal(schema.properties.readings.maxItems,0);
  assert.equal(schema.$defs.recommendation.properties.evidence.minItems,0);
  assert.equal(schema.$defs.recommendation.properties.evidence.maxItems,0);
 }
 const schema=curationSelectionSchema(list(32,'c'),list(38,'a'),list(16,'s')) as JsonNode;
 assert.equal(verifySchema(schema,schema),86);
 assert.deepEqual(schema.$defs.source.enum,list(16,'s'));
 assert.equal(schema.$defs.recommendation.properties.evidence.minItems,0);
 assert.equal(schema.$defs.recommendation.properties.evidence.maxItems,2);
 assert.equal(schema.properties.readings.maxItems,8);
 assert.deepEqual(schema.$defs.reading.required,['ref','passage','observation']);
 assert.equal(schema.$defs.reading.properties.ref.$ref,'#/$defs/source');
 const small=curationSelectionSchema(list(12,'c'),['a0'],['s0','s1']) as JsonNode;
 assert.equal(small.properties.readings.maxItems,2);
 assert.equal(CurationSchema.safeParse({readings:Array(9).fill({}),ranking:[],recommendations:[]}).success,false);
});

test('malformed candidate records are isolated without losing complete valid identities',()=>{
 const draft=DraftSchema.parse({lenses:[lens],candidates:[{...candidate,year:'unknown'},candidate,{...candidate,anchors:[]}],queries:[]});
 const survivors=draft.candidates.map(row=>CuratorialCandidate.safeParse(row)).filter(row=>row.success);
 assert.equal(survivors.length,1);
 assert.deepEqual(survivors[0].data,candidate);
 assert.equal(DraftSchema.safeParse({lenses:[lens],candidates:Array(25).fill(candidate),queries:[]}).success,false);
 assert.equal(CuratorialCandidate.safeParse({...candidate,director:''}).success,false);
 assert.equal(CuratorialCandidate.safeParse({...candidate,year:2201}).success,false);
 assert.equal(CuratorialCandidate.parse({...candidate,bridge:'x'.repeat(650)}).bridge.length,600);
});

test('absent or malformed optional draft queries preserve the planned films and usable query siblings',()=>{
 for(const queries of [undefined,null,{},'not an array']){
  const parsed=DraftSchema.parse({lenses:[lens],candidates:[candidate],queries});
  assert.deepEqual(parsed.candidates,[candidate]);
  assert.deepEqual(parsed.queries,[]);
 }
 const valid={query:'Late Spring formal analysis',anchors:['a0'],purpose:'candidate'};
 const mixed=DraftSchema.parse({lenses:[lens],candidates:[candidate],queries:[null,{...valid,purpose:'unsupported'},valid,{...valid,anchors:'a0'}]});
 assert.deepEqual(mixed.candidates,[candidate]);
 assert.deepEqual(mixed.queries,[valid]);
 assert.equal(DraftSchema.parse({lenses:[lens],candidates:[candidate],queries:Array(10).fill(valid)}).queries.length,6);
});

test('malformed curated films and optional evidence notes do not contaminate readable siblings',()=>{
 const output=CurationSchema.parse({ranking:['c0','c1'],recommendations:[{...curated,anchors:null},curated]});
 const survivors=output.recommendations.map(row=>CuratedFilm.safeParse(row)).filter(row=>row.success);
 assert.equal(survivors.length,1);
 assert.deepEqual(survivors[0].data,curated);
 const evidence=CuratedFilm.parse({...curated,evidence:[{ref:'s0',passage:[],point:'invalid'},{ref:'s1',passage:'An exact supplied passage.',point:'A limited supported observation.'}]}).evidence;
 assert.equal(evidence.map(note=>EvidenceNote.safeParse(note)).filter(note=>note.success).length,1);
 assert.equal(EvidenceNote.safeParse({ref:'s0',passage:'x'.repeat(501),point:'Too much copied text.'}).success,false);
});

test('truncated drafts retain only complete original records and never finish a candidate or search query',()=>{
 const raw=`{"lenses":[${JSON.stringify(lens)}],"candidates":[${JSON.stringify(candidate)},{"title":"Unfinished`;
 const recovered=DraftSchema.parse(parseCurationOutput(raw,'draft'));
 assert.deepEqual(recovered,{lenses:[lens],candidates:[candidate],queries:[]});
 const completeQueries={query:'Late Spring formal analysis',anchors:['a0'],purpose:'candidate'};
 const withQueries=`{"lenses":[${JSON.stringify(lens)}],"candidates":[${JSON.stringify(candidate)}],"queries":[${JSON.stringify(completeQueries)},{"query":"Unfinished`;
 assert.deepEqual(DraftSchema.parse(parseCurationOutput(withQueries,'draft')).queries,[completeQueries]);
 assert.equal(parseCurationOutput('{"lenses":[{"id":"unfinished','draft'),null);
 assert.equal(parseCurationOutput(`{"lenses":[${JSON.stringify(lens)}],"candidates":[{"title":"unfinished`,'draft'),null);
});

test('truncated selections recover complete film explanations without inventing evidence or rejected identities',()=>{
 const raw=`{"ranking":["c9","c0"],"recommendations":[${JSON.stringify(curated)},{"candidate":"c1","why":"unfinished`;
 assert.deepEqual(CurationSchema.parse(parseCurationOutput(raw,'curate')),{readings:[],ranking:['c0'],recommendations:[curated],rejected:[]});
 const incompleteNote=`{"recommendations":[{"candidate":"c0","evidence":[{"ref":"s0","passage":"unfinished`;
 assert.equal(parseCurationOutput(incompleteNote,'curate'),null);
});

test('complete fenced JSON remains unchanged while incomplete detail prose is never repaired',()=>{
 const full={ranking:['c0'],recommendations:[curated],rejected:[]};
 assert.deepEqual(parseCurationOutput('```json\n'+JSON.stringify(full)+'\n```','curate'),full);
 const detail={paragraphs:['First complete paragraph.','Second complete paragraph.','Third complete paragraph.']};
 assert.deepEqual(parseCurationOutput(JSON.stringify(detail),'detail'),detail);
 assert.equal(parseCurationOutput('{"paragraphs":["First complete paragraph.","Unfinished','detail'),null);
 assert.equal(verifySchema(detailOutputSchema,detailOutputSchema),0);
 assert.equal((detailOutputSchema as JsonNode).properties.paragraphs.minItems,3);
 assert.equal((detailOutputSchema as JsonNode).properties.paragraphs.maxItems,3);
 assert.equal(DetailSchema.safeParse({paragraphs:['Only one.']}).success,false);
});

test('display boundaries remove serialization debris without rewriting verified excerpt text',()=>{
 const readable='The comparison turns on how each film organizes duration.';
 const broken=readable+'” },“inferenceWhyKo”:{ } , , ,';
 assert.equal(CuratedFilm.parse({...curated,why:broken}).why,readable);
 assert.equal(CuratorialCandidate.parse({...candidate,bridge:broken}).bridge,readable);
 assert.deepEqual(DetailSchema.parse({paragraphs:[broken,'A second readable paragraph.']}).paragraphs,[readable,'A second readable paragraph.']);
 const passage='The critic writes: "time, objects, and {their relations}."';
 assert.equal(EvidenceNote.parse({ref:'s0',passage,point:broken}).passage,passage);
 assert.equal(EvidenceNote.parse({ref:'s0',passage,point:broken}).point,readable);
});
