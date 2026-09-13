import test from 'node:test';
import assert from 'node:assert/strict';
import {collection,filmById,recommendCollection,searchCollection} from '../lib/catalogue';
import {weights,commitSnapshot,restoreSnapshot,parseSession,EMPTY_SESSION,SnapshotSchema,type Snapshot} from '../lib/domain';
import {allowedSourceUrl,supports} from '../lib/server/grounding';
const film=(id:string)=>filmById(id)!;
const snapshot=(id:string,trail:string[]=[]):Snapshot=>SnapshotSchema.parse({id,createdAt:new Date().toISOString(),seeds:[film('closeup')],trail:trail.map(film),...recommendCollection([film('closeup')],trail.map(film))});
test('Korean titles, director and punctuation search resolve real films',()=>{assert.equal(searchCollection('클로즈업')[0].id,'closeup');assert.ok(searchCollection('Kiarostami').length>1);assert.equal(searchCollection('F for Fake')[0].id,'fake');assert.equal(searchCollection('no matching movie').length,0);});
test('starting and followed films have exactly equal influence',()=>{const w=weights([film('closeup'),film('fake')],[film('apple'),film('boards')]);assert.deepEqual(w.map(x=>x.weight),[.25,.25,.25,.25]);});
test('every starting point has grounded, unique, non-self recommendations',()=>{for(const seed of collection){const batch=recommendCollection([seed],[]);assert.ok(batch.recommendations.length>=3);assert.ok(batch.recommendations.length<=12);const sources=new Set(batch.sources.map(s=>s.id));assert.equal(new Set(batch.recommendations.map(r=>r.film.id)).size,batch.recommendations.length);for(const r of batch.recommendations){assert.notEqual(r.film.id,seed.id);assert.ok(r.sourceIds.every(id=>sources.has(id)));assert.ok(r.connections.every(c=>c.anchorId===seed.id&&c.sourceIds.every(id=>sources.has(id))));}}});
test('follow excludes all selected films and changes the rank',()=>{const a=recommendCollection([film('closeup')],[]);const b=recommendCollection([film('closeup')],[film('apple')]);assert.ok(b.recommendations.every(r=>!['closeup','apple'].includes(r.film.id)));assert.notDeepEqual(a.recommendations.map(r=>r.film.id),b.recommendations.map(r=>r.film.id));});
test('undo restores the exact batch and evidence; successful branch replaces suffix only',()=>{let s=commitSnapshot(EMPTY_SESSION,snapshot('zero'),true);s=commitSnapshot(s,snapshot('one',['apple']),false);s=commitSnapshot(s,snapshot('two',['apple','boards']),false);const original=s.snapshots[0];s=restoreSnapshot(s,0);assert.equal(s.snapshots[s.cursor],original);assert.equal(s.snapshots.length,3);assert.throws(()=>commitSnapshot(s,{...snapshot('bad'),recommendations:[]},false));assert.equal(s.snapshots.length,3);s=commitSnapshot(s,snapshot('branch',['fake']),false);assert.deepEqual(s.snapshots.map(x=>x.id),['zero','branch']);assert.deepEqual(parseSession(JSON.stringify(s)),JSON.parse(JSON.stringify(s)));});
test('invalid saved evidence and unknown restore targets are rejected',()=>{const s=commitSnapshot(EMPTY_SESSION,snapshot('initial'),true);s.snapshots[0].recommendations[0].connections[0].sourceIds=['missing'];assert.throws(()=>parseSession(JSON.stringify(s)));assert.throws(()=>restoreSnapshot(s,-1));});
test('exhausted collection returns an honest empty batch',()=>{const b=recommendCollection([collection[0]],collection.slice(1));assert.deepEqual(b.recommendations,[]);});
test('source fetches reject private, lookalike, credential-bearing and non-essay URLs',()=>{assert.ok(allowedSourceUrl('https://www.criterion.com/current/posts/123-a-film'));for(const u of ['http://www.criterion.com/current/posts/x','https://localhost/a','https://www.criterion.com.evil.test/current/posts/x','https://x@www.criterion.com/current/posts/x','https://www.criterion.com/films/123'])assert.equal(allowedSourceUrl(u),false);});
test('supporting span must exist and name its supported films itself',()=>{const span='Close-Up and The Apple use reenactment to reconsider who can represent a life.';assert.ok(supports(span,span,['Close-Up','The Apple']));assert.equal(supports('Close-Up / The Apple. A generic comment about cinema without any named film.','A generic comment about cinema without any named film.',['Close-Up','The Apple']),false);assert.equal(supports(span,'An invented comparison of Close-Up and The Apple.',['Close-Up']),false);});

test('Korean display uses database labels and preserves a title when none exists',async()=>{const {titleOf}=await import('../lib/domain');assert.equal(titleOf(film('closeup'),'ko'),'클로즈업');assert.equal(titleOf({...film('closeup'),titleKo:undefined},'ko'),'Close-Up');});
test('overlap bonus is modest and duplicate or unknown anchors earn no extra weight',async()=>{const {connectionScore}=await import('../lib/ranking');const template=recommendCollection([film('closeup')],[]).recommendations[0];const edge=template.connections[0];const one={...template,connections:[edge]};const duplicates={...template,connections:[edge,edge,{...edge,anchorId:'unknown'}]};assert.equal(connectionScore(one,[film('closeup')],[]),connectionScore(duplicates,[film('closeup')],[]));const two={...template,connections:[{...edge,anchorId:'closeup',relation:'direct_connection' as const},{...edge,anchorId:'fake',relation:'direct_connection' as const}]};assert.equal(connectionScore(two,[film('closeup'),film('fake')],[]),1.06);});
test('diversity changes the order of equally supported candidates without losing evidence',async()=>{const {rankRecommendations}=await import('../lib/ranking');const template=recommendCollection([film('closeup')],[]).recommendations[0];const a={...template,film:{...template.film,id:'a',director:'Director A',country:'Iran',year:1990}};const b={...template,film:{...template.film,id:'b',director:'Director A',country:'Iran',year:1991}};const c={...template,film:{...template.film,id:'c',director:'Director C',country:'Japan',year:1960}};const ranked=rankRecommendations([a,b,c],[film('closeup')],[]);assert.deepEqual(ranked.map(r=>r.film.id),['a','c','b']);assert.equal(ranked[0].sourceIds,template.sourceIds);});

import {titleMatches,titleMentioned} from '../lib/server/grounding';
import {RecommendationSchema,safePoster} from '../lib/domain';
import {allocateQuota} from '../lib/server/quota-policy';
test('AI-only recommendations persist honestly and cannot carry fabricated evidence',()=>{
 const template=recommendCollection([film('closeup')],[]).recommendations[0];
 const ai={...template,sourceIds:[],connections:[{...template.connections[0],relation:'ai_inference',sourceIds:[]}]};
 assert.ok(RecommendationSchema.safeParse(ai).success);
 assert.equal(RecommendationSchema.safeParse({...ai,sourceIds:['phantom']}).success,false);
 assert.equal(RecommendationSchema.safeParse({...ai,connections:[{...ai.connections[0],sourceIds:['phantom']}]}).success,false);
 assert.equal(RecommendationSchema.safeParse({...ai,connections:[{...ai.connections[0],relation:'grounded_interpretation'}]}).success,false);
 const state=commitSnapshot(EMPTY_SESSION,{...snapshot('ai'),recommendations:[RecommendationSchema.parse(ai)],sources:[]},true);
 assert.equal(parseSession(JSON.stringify(state)).snapshots[0].recommendations[0].connections[0].relation,'ai_inference');
});
test('public cost cap applies per caller, resets by UTC day, and does not mutate previous state',()=>{
 const now=Date.parse('2026-09-12T23:59:00Z');let state;
 for(let i=0;i<6;i++){const result=allocateQuota(state,'caller',now,10);assert.ok(result.allowed);state=result.state;}
 const saved=JSON.stringify(state);assert.equal(allocateQuota(state,'caller',now,10).code,'RATE_LIMIT');assert.equal(JSON.stringify(state),saved);
 for(let i=0;i<4;i++){const result=allocateQuota(state,`other-${i}`,now,10);assert.ok(result.allowed);state=result.state;}
 assert.equal(allocateQuota(state,'another',now,10).code,'DAILY_LIMIT');
 const tomorrow=allocateQuota(state,'caller',now+60000,10);assert.ok(tomorrow.allowed);assert.equal(tomorrow.state.total,1);
 assert.ok(allocateQuota({day:'2026-09-12',total:6,callers:{caller:{at:now-600000,count:6}}},'caller',now,10).allowed);
});
test('poster proxy accepts only trusted image hosts and valid local poster paths',()=>{
 assert.equal(safePoster('https://image.tmdb.org/t/p/w500/test.jpg'),'https://image.tmdb.org/t/p/w500/test.jpg');
 for(const url of ['https://image.tmdb.org.evil.test/x','http://image.tmdb.org/x','https://x@image.tmdb.org/a','https://image.tmdb.org:8080/a','https://127.0.0.1/a','/posters/../.env.local'])assert.equal(safePoster(url),'');
});
test('evidence titles preserve boundaries, short names and documented article variants',()=>{
 assert.equal(titleMentioned('A honeymoon sequence','Moon'),false);
 assert.equal(titleMentioned('The critic compares Moon and Solaris.','Moon'),true);
 assert.equal(titleMentioned('A study of M and its sound design.','M'),true);
 assert.equal(titleMentioned('The road movie tradition','The Road'),true);
 assert.equal(titleMentioned('a broad palette','The Road'),false);
 assert.equal(titleMentioned('Close-Up and Moment of Innocence explore reenactment.','A Moment of Innocence'),true);
 assert.equal(titleMatches('The Moment of Innocence','A Moment of Innocence'),true);
});

import {retrievedSources,canonicalSourceUrl,filmMentioned} from '../lib/server/grounding';
test('actual search URLs survive malformed model notes and tracking parameters',()=>{
 const url='https://www.criterion.com/current/posts/4445-the-before-trilogy-time-regained?srsltid=tracking&utm_source=test';
 const sources=retrievedSources({output:[{type:'web_search_call',action:{sources:[{url,title:'Time Regained'},{url:'https://localhost/private'}]}},{type:'message',content:[{type:'output_text',text:'invalid JSON } inferenceWhyKo'}]}]});
 assert.deepEqual(sources,[{url:canonicalSourceUrl(url),title:'Time Regained'}]);
 assert.equal(sources[0].url.includes('srsltid'),false);
 assert.ok(allowedSourceUrl('https://www.biff.kr/eng/html/archive/arc_history_view.asp?m_idx=872'));
 assert.ok(allowedSourceUrl('https://journal.kci.go.kr/snu-ioh/archive/articleView?artiId=ART003060860'));
 assert.ok(filmMentioned('춘향뎐의 판소리와 영화 형식',{title:'Chunhyang',titleKo:'춘향뎐'}));
});
test('existing saved explanations clean serialization fragments without losing a trail',()=>{
 const sn=snapshot('saved-bad-copy');sn.recommendations[0].connections[0].why='Notice how everyday gestures reveal the passage of time.” },“inferenceWhyKo”:{ } , , , ,';
 const saved=parseSession(JSON.stringify(commitSnapshot(EMPTY_SESSION,sn,true)));
 assert.equal(saved.snapshots[0].recommendations[0].connections[0].why,'Notice how everyday gestures reveal the passage of time.');
 assert.equal(saved.snapshots[0].recommendations.length,sn.recommendations.length);
});
