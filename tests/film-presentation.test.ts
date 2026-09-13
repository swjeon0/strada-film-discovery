import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeFilmPresentation,retainSelectedPosters} from '../lib/film-presentation';
import type {Film} from '../lib/domain';
const search:Film={id:'tmdb:123',title:'Search title',titleKo:'DB 한국어 제목',year:2000,director:'',poster:'https://image.tmdb.org/t/p/w500/korean-poster.jpg'};
const details:Film={id:'canonical-film',title:'Full database title',year:2000,director:'Verified director',poster:'/posters/english-poster.jpg',synopsisEn:'A verified synopsis.',genres:['18'],titleKo:'검증된 한국어 제목',titleKoSource:'https://www.themoviedb.org/movie/123'};

test('selecting a localized search hit preserves its artwork while accepting full canonical metadata',()=>{
 const selected=mergeFilmPresentation(search,details);
 assert.equal(selected.poster,search.poster);
 assert.equal(selected.id,details.id);
 assert.equal(selected.title,details.title);
 assert.equal(selected.director,details.director);
 assert.equal(selected.synopsisEn,details.synopsisEn);
 assert.equal(selected.titleKo,details.titleKo);
 assert.equal(selected.titleKoSource,details.titleKoSource);
 assert.deepEqual(selected.genres,details.genres);
});

test('absent or rejected artwork falls back to valid details without discarding a DB Korean title',()=>{
 for(const poster of ['', 'https://evil.example/poster.jpg']){
  const selected=mergeFilmPresentation({...search,poster},{...details,titleKo:undefined,titleKoSource:undefined});
  assert.equal(selected.poster,details.poster);
  assert.equal(selected.titleKo,search.titleKo);
  assert.equal(selected.titleKoSource,'https://www.themoviedb.org/movie/123');
 }
});

test('generation and catalogue restoration preserve chosen artwork by film ID without changing other films',()=>{
 const selected=mergeFilmPresentation(search,details);
 const server={...details,director:'Updated verified director'};
 const unrelated={...details,id:'other-film'};
 const merged=retainSelectedPosters([server,unrelated],[selected]);
 assert.equal(merged[0].poster,search.poster);
 assert.equal(merged[0].director,server.director);
 assert.equal(merged[1],unrelated);
 assert.equal(mergeFilmPresentation(selected,server).poster,search.poster);
});
