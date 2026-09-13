import test from 'node:test';
import assert from 'node:assert/strict';
import {weights,type Film} from '../lib/domain';
import {RECOMMENDATION_COUNT,CANDIDATE_COUNT,discoveryModelContext,discoveryCacheKey,coversDiscoveryContext,sourceSearchOrder} from '../lib/recommendation-policy';
import {connectionScore,rankRecommendations} from '../lib/ranking';
const film=(i:number):Film=>({id:`tmdb:${i+1}`,title:`Film ${i}`,year:1960+i,director:`Director ${i}`,poster:''});
test('all 38 allowed selections retain equal weight with no last-eight cutoff',()=>{
 const seeds=Array.from({length:8},(_,i)=>film(i)),trail=Array.from({length:30},(_,i)=>film(i+8));
 const a=weights(seeds,trail),b=weights([...seeds].reverse(),[...trail].reverse());
 assert.equal(a.length,38);assert.ok(a.every(x=>x.weight===1/38));
 assert.deepEqual(Object.fromEntries(a.map(x=>[x.film.id,x.weight])),Object.fromEntries(b.map(x=>[x.film.id,x.weight])));
});
test('12 visible discoveries are validated from 24 short proposals',()=>{
 assert.equal(RECOMMENDATION_COUNT,12);assert.equal(CANDIDATE_COUNT,24);
});
test('the model receives old and newly encountered films once, independent of chronology',()=>{
 const history=Array.from({length:372},(_,i)=>film(i));const selected=[{...film(0),title:'Authoritative DB title'},film(400)];
 const context=discoveryModelContext(selected,history);
 assert.equal(context.length,373);assert.equal(context.find(f=>f.id===film(0).id)?.title,'Authoritative DB title');
 assert.ok(context.some(f=>f.id===film(371).id));assert.ok(context.some(f=>f.id===film(400).id));
 assert.deepEqual(context,discoveryModelContext([...selected].reverse(),[...history].reverse()));
 assert.ok(context.every(f=>f.weight===1/373));
});
test('different discovery history cannot reuse an unrelated cached recommendation batch',()=>{
 const key=(history:Film[])=>discoveryCacheKey('gpt-4o-mini',['tmdb:1'],['tmdb:2'],history);
 assert.notEqual(key([film(2)]),key([film(3)]));assert.equal(key([film(2),film(3)]),key([film(3),film(2)]));
});
test('source-free inference requires several real context representatives and scores the whole path',()=>{
 const context=[{code:'d0'},{code:'d1'},{code:'d2'}];
 assert.ok(coversDiscoveryContext(['d0','d2'],context));assert.equal(coversDiscoveryContext(['d0','d0','invented'],context),false);
 assert.ok(coversDiscoveryContext(['d0'],[{code:'d0'}]));
 const rec={film:film(9),sourceIds:[],contextScope:'discovery' as const,connections:[{anchorId:film(0).id,anchorTitle:film(0).title,relation:'ai_inference' as const,why:'A shared thread across the discoveries.',sourceIds:[]}]};
 assert.equal(connectionScore(rec,[film(0)],[film(1)]),connectionScore({...rec,connections:[{...rec.connections[0],anchorId:film(1).id}]},[film(0)],[film(1)]));
 const batch=Array.from({length:16},(_,i)=>({...rec,film:film(i+2)}));
 assert.equal(rankRecommendations(batch,[film(0)],[film(1)],[],RECOMMENDATION_COUNT).length,12);
});
test('finite source search budget does not favor insertion order',()=>{
 const films=Array.from({length:12},(_,i)=>film(i));
 assert.deepEqual(sourceSearchOrder(films).map(f=>f.id),sourceSearchOrder([...films].reverse()).map(f=>f.id));
});
