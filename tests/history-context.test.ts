import test from 'node:test';
import assert from 'node:assert/strict';
import {discoveryHistoryContext,MAX_DISCOVERED_FILMS} from '../lib/discovery-context';
import type {Snapshot} from '../lib/domain';

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

test('undo excludes future snapshots while retaining the active branch and deduplicating films',()=>{
 const snapshots=[snapshot(0),snapshot(1),snapshot(2)];
 snapshots[1].recommendations[0]=snapshots[0].recommendations[0];
 const context=discoveryHistoryContext({snapshots,cursor:1},true);
 assert.equal(context.discoveredFilms.length,23);
 assert.deepEqual(context.seenIds,context.discoveredFilms.map(f=>f.id));
 assert.ok(context.seenIds.includes('film-0'));
 assert.ok(context.seenIds.includes('film-23'));
 assert.ok(!context.seenIds.includes('film-24'));
});

test('starting a new path never imports films from an unrelated saved path',()=>{
 assert.deepEqual(discoveryHistoryContext({snapshots:[snapshot(0)],cursor:0},false),{discoveredFilms:[],seenIds:[]});
 assert.deepEqual(discoveryHistoryContext({snapshots:[],cursor:-1},true),{discoveredFilms:[],seenIds:[]});
});
