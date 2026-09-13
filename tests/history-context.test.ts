import test from 'node:test';
import assert from 'node:assert/strict';
import {discoveryHistoryContext,MAX_DISCOVERED_FILMS} from '../lib/discovery-context';
import {EMPTY_SESSION,MAX_SEEN_FILMS,MAX_SESSION_SNAPSHOTS,MAX_SESSION_STORAGE_CHARS,commitSnapshot,parseSession,restoreSnapshot,type Snapshot} from '../lib/domain';

const snapshot=(step:number):Snapshot=>({
 id:`step-${step}`,createdAt:'2026-09-12T00:00:00Z',seeds:[{id:'seed',title:'Starting film',year:1990,director:'Director',poster:''}],trail:[],sources:[],mode:'live',
 recommendations:Array.from({length:12},(_,n)=>({film:{id:`film-${step*12+n}`,title:`Film ${step*12+n}`,year:2000,director:'Director',poster:'/posters/unused.jpg',synopsisEn:'Omitted from the compact context.'},connections:[{anchorId:'seed',anchorTitle:'Starting film',relation:'ai_inference',why:'A relationship.',sourceIds:[]}],sourceIds:[]})),
});

test('discovery history retains all 372 possible films with compact database identity only',()=>{
 const snapshots=Array.from({length:31},(_,step)=>snapshot(step));
 const context=discoveryHistoryContext({snapshots,cursor:30},true);
 assert.equal(context.discoveredFilms.length,372);
 assert.equal(context.seenIds.length,372);
 assert.deepEqual(context.discoveredFilms[0],{id:'film-0',title:'Film 0',year:2000,director:'Director'});
 assert.equal(context.discoveredFilms[371].id,'film-371');
 assert.ok(context.discoveredFilms.length<=MAX_DISCOVERED_FILMS);
});

test('undo retains all previously displayed films including future snapshots without double counting',()=>{
 const snapshots=[snapshot(0),snapshot(1),snapshot(2)];
 snapshots[1].recommendations[0]=snapshots[0].recommendations[0];
 const context=discoveryHistoryContext({snapshots,cursor:1},true);
 assert.equal(context.discoveredFilms.length,35);
 assert.deepEqual(context.seenIds,context.discoveredFilms.map(f=>f.id));
 assert.ok(context.seenIds.includes('film-0'));
 assert.ok(context.seenIds.includes('film-23'));
 assert.ok(context.seenIds.includes('film-24'));
 assert.ok(context.seenIds.includes('film-35'));
});

test('starting a new path never imports films from an unrelated saved path',()=>{
 assert.deepEqual(discoveryHistoryContext({snapshots:[snapshot(0)],cursor:0},false),{discoveredFilms:[],seenIds:[]});
 assert.deepEqual(discoveryHistoryContext({snapshots:[],cursor:-1},true),{discoveredFilms:[],seenIds:[]});
});

test('more than 31 regeneration steps survive reload and retain exclusion IDs after snapshot trimming',()=>{
 let session=EMPTY_SESSION;
 for(let step=0;step<70;step++)session=commitSnapshot(session,{...snapshot(step),action:step?'regenerate':'initial'},step===0);
 assert.equal(session.snapshots.length,MAX_SESSION_SNAPSHOTS);
 assert.equal(session.snapshots[0].id,'step-6');
 assert.equal(session.archivedSeenIds?.length,72);
 session=parseSession(JSON.stringify(session));
 const context=discoveryHistoryContext(session,true);
 assert.equal(context.seenIds.length,840);
 assert.equal(context.discoveredFilms.length,MAX_DISCOVERED_FILMS);
 assert.ok(context.seenIds.includes('film-0'));
 assert.ok(context.seenIds.includes('film-839'));
});

test('undo and branching keep all displayed exclusions including archived ancestors and abandoned future discoveries',()=>{
 let session=EMPTY_SESSION;
 for(let step=0;step<70;step++)session=commitSnapshot(session,snapshot(step),step===0);
 session=restoreSnapshot(session,1);
 const before=discoveryHistoryContext(session,true);
 assert.equal(before.seenIds.length,840);
 assert.ok(before.seenIds.includes('film-0'));
 assert.ok(before.seenIds.includes('film-95'));
 assert.ok(before.seenIds.includes('film-96'));
 assert.ok(before.seenIds.includes('film-839'));
 session=commitSnapshot(session,{...snapshot(100),action:'manual'},false);
 const after=discoveryHistoryContext(session,true);
 assert.deepEqual(session.snapshots.map(sn=>sn.id),['step-6','step-7','step-100']);
 assert.equal(after.seenIds.length,852);
 assert.ok(after.seenIds.includes('film-1200'));
 assert.ok(after.seenIds.includes('film-839'));
 assert.ok(session.archivedSeenIds?.includes('film-839'));
 assert.equal(discoveryHistoryContext(parseSession(JSON.stringify(session)),true).seenIds.length,852);
 const fresh=commitSnapshot(session,snapshot(200),true);
 assert.equal(fresh.archivedSeenIds,undefined);
 assert.deepEqual(discoveryHistoryContext(fresh,true).seenIds,snapshot(200).recommendations.map(rec=>rec.film.id));
});

test('large saved explanations trim old snapshots without forgetting regeneration exclusions',()=>{
 let session=EMPTY_SESSION;
 for(let step=0;step<10;step++){
  const sn=snapshot(step);
  sn.recommendations=sn.recommendations.map(rec=>({...rec,detailToken:'x'.repeat(15000)}));
  session=commitSnapshot(session,sn,step===0);
 }
 assert.ok(session.snapshots.length<10);
 assert.ok(JSON.stringify(session).length<=MAX_SESSION_STORAGE_CHARS);
 assert.equal(discoveryHistoryContext(session,true).seenIds.length,120);
 assert.equal(parseSession(JSON.stringify(session)).snapshots.at(-1)?.id,'step-9');
});

test('history capacity fails explicitly rather than silently making old films eligible',()=>{
 const archivedSeenIds=Array.from({length:MAX_SEEN_FILMS},(_,i)=>`old-${i}`);
 const session={...EMPTY_SESSION,archivedSeenIds};
 assert.throws(()=>commitSnapshot(session,snapshot(0),false),/history limit/);
 assert.deepEqual(session.snapshots,[]);
 assert.deepEqual(commitSnapshot(session,snapshot(0),true).snapshots.map(sn=>sn.id),['step-0']);
});

test('v2 saved paths without new action or curation fields remain readable',()=>{
 const old={version:2,seedDraft:snapshot(0).seeds,snapshots:[snapshot(0),snapshot(1)],cursor:0};
 const restored=parseSession(JSON.stringify(old));
 assert.equal(restored.snapshots[0].action,undefined);
 assert.deepEqual(discoveryHistoryContext(restored,true).seenIds,[...snapshot(0).recommendations,...snapshot(1).recommendations].map(rec=>rec.film.id));
});
