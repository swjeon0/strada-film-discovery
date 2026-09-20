import test from 'node:test';
import assert from 'node:assert/strict';
import type {Film} from '../lib/domain';
import type {Reference} from '../lib/server/source-search';
import {namedAnchorCoverage,prioritizeSupportedCoverage,sanitizePlanEvidence,softlyDiversifyRanking,type CuratedPlan} from '../lib/server/curation-gates';

const first:Film={id:'tmdb:1',title:'Late Spring',titleKo:'만춘',year:1949,director:'Yasujiro Ozu',poster:'',country:'Japan'};
const second:Film={id:'tmdb:2',title:'Jeanne Dielman, 23, quai du Commerce, 1080 Bruxelles',titleKo:'잔느 딜망',aliases:['Jeanne Dielman'],year:1975,director:'Chantal Akerman',poster:'',country:'Belgium'};
const anchors=new Map([['a0',first],['a1',second]]);
const plan=(candidate:string,why:string):CuratedPlan=>({candidate,lens:'Duration',anchors:['a0','a1'],why,bridge:'',contrast:'',evidence:[]});

test('joint-reading coverage requires the prose to name and interpret two claimed anchors',()=>{
 assert.equal(namedAnchorCoverage(plan('c0','Late Spring and Jeanne Dielman turn domestic duration into different structures of attention.'),anchors).valid,true);
 assert.equal(namedAnchorCoverage(plan('c0','Both selected films share an interesting concern with time.'),anchors).valid,false);
 const plans=new Map<string,CuratedPlan>();
 for(let i=0;i<12;i++)plans.set(`c${i}`,plan(`c${i}`,i<8?'Late Spring and Jeanne Dielman organize domestic duration through opposing rhythms.':'Both selections concern time.'));
 const ranked=['c8','c9','c0','c1','c2','c3','c4','c5','c6','c7','c10','c11'];
 assert.deepEqual(prioritizeSupportedCoverage(ranked,plans,anchors).slice(0,8),['c0','c1','c2','c3','c4','c5','c6','c7']);
});

test('evidence survives only when its passage is copied and supports a claimed side',()=>{
 const reference:Reference={source:{id:'s0',title:'Late Spring and domestic space',publisher:'Example',author:'Critic',date:null,url:'https://www.filmcomment.com/article/curation-gate-test',type:'criticism',scope:'interpretive_context',summary:'A critical reading.',accessLevel:'full_text'},text:'Late Spring turns domestic space into a measured pattern of absence and repetition that gradually changes its emotional pressure.',anchorIds:[first.id],purpose:'anchor'};
 const candidate:Film={id:'tmdb:3',title:'Candidate',year:1980,director:'Director',poster:''};
 const valid='Late Spring turns domestic space into a measured pattern of absence and repetition';
 const value={...plan('c0','Late Spring and Jeanne Dielman organize domestic duration through opposing rhythms.'),evidence:[{ref:'s0',passage:valid,point:'The passage supports the Late Spring side.'},{ref:'s0',passage:'This sentence was never in the article and cannot support the claim.',point:'Invented.'}]};
 assert.deepEqual(sanitizePlanEvidence(value,candidate,new Map([['s0',reference]]),anchors).evidence,[{ref:'s0',passage:valid,point:'The passage supports the Late Spring side.'}]);
});

test('diversity only reranks nearby redundancy and never removes or hard-blocks a film',()=>{
 const rows=new Map([
  ['c0',{code:'c0',film:{id:'0',title:'A',year:1990,director:'Same Director',poster:'',country:'France'},draft:{lens:'l1'}}],
  ['c1',{code:'c1',film:{id:'1',title:'B',year:1991,director:'Same Director',poster:'',country:'France'},draft:{lens:'l1'}}],
  ['c2',{code:'c2',film:{id:'2',title:'C',year:1960,director:'Other Director',poster:'',country:'Japan'},draft:{lens:'l2'}}],
  ['c3',{code:'c3',film:{id:'3',title:'D',year:2010,director:'Third Director',poster:'',country:'Brazil'},draft:{lens:'l3'}}],
 ]);
 const result=softlyDiversifyRanking(['c0','c1','c2','c3'],rows);
 assert.equal(result[0],'c0');assert.equal(result[1],'c2');assert.deepEqual(new Set(result),new Set(['c0','c1','c2','c3']));
});
