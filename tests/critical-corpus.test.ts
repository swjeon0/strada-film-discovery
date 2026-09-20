import test from 'node:test';
import assert from 'node:assert/strict';
import type {Film} from '../lib/domain';
import {corpusOperationQuery,retrieveCorpusSignals} from '../lib/server/critical-corpus';

const films:Film[]=[
 {id:'tmdb:20530',title:'Late Spring',titleKo:'만춘',year:1949,director:'Yasujiro Ozu',poster:''},
 {id:'tmdb:2742',title:'Jeanne Dielman, 23, quai du Commerce, 1080 Bruxelles',titleKo:'잔느 딜망',aliases:['Jeanne Dielman'],year:1975,director:'Chantal Akerman',poster:''},
];

test('reviewed corpus retrieval is set-based, bounded and keeps claims separate from quote evidence',()=>{
 const first=retrieveCorpusSignals(films),reversed=retrieveCorpusSignals([...films].reverse());
 assert.deepEqual(first.map(row=>row.id),reversed.map(row=>row.id));
 assert.ok(first.length<=8);
 assert.ok(first.some(row=>row.id==='C01'&&row.matchedFilmIds.includes('tmdb:20530')));
 assert.ok(first.some(row=>row.id==='P09'&&row.matchedFilmIds.includes('tmdb:2742')));
 assert.ok(first.every(row=>row.boundary&&row.hook&&!('passage' in row)));
});

test('corpus operations become a bounded lens query across every selected film',()=>{
 const query=corpusOperationQuery(retrieveCorpusSignals(films),films);
 assert.ok(query);assert.equal(query.purpose,'lens');assert.deepEqual(query.filmIds,films.map(film=>film.id));
 assert.match(query.query,/Boundary:/);assert.ok(query.query.length<=500);
});

test('a reviewed comparison exposes a seed to operation to candidate path',()=>{
 const closeup:Film={id:'closeup',title:'Close-Up',year:1990,director:'Abbas Kiarostami',poster:''};
 const candidate:Film={id:'tmdb:84175',title:'Like Someone in Love',year:2012,director:'Abbas Kiarostami',poster:''};
 const signal=retrieveCorpusSignals([closeup,candidate]).find(row=>row.id==='C03');
 assert.ok(signal);assert.deepEqual(new Set(signal.matchedFilmIds),new Set([closeup.id,candidate.id]));
});
