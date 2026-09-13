import test from 'node:test';
import assert from 'node:assert/strict';
import {weights,type Film,type Recommendation} from '../lib/domain';
import {RECOMMENDATION_COUNT,CANDIDATE_COUNT,discoveryModelContext,discoveryCacheKey,coversDiscoveryContext,sourceSearchOrder,selectFreshRecommendations,validateFreshRecommendations} from '../lib/recommendation-policy';
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
test('only deliberately selected films define taste, independent of display or selection chronology',()=>{
 const history=Array.from({length:372},(_,i)=>film(i));const selected=[{...film(0),title:'Authoritative DB title'},film(400)];
 const context=discoveryModelContext(selected,history);
 assert.equal(context.length,2);assert.equal(context.find(f=>f.id===film(0).id)?.title,'Authoritative DB title');
 assert.ok(!context.some(f=>f.id===film(371).id));assert.ok(context.some(f=>f.id===film(400).id));
 assert.deepEqual(context,discoveryModelContext([...selected].reverse(),[...history].reverse()));
 assert.ok(context.every(f=>f.weight===1/2));
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

const recommendation=(i:number):Recommendation=>({film:film(i),sourceIds:[],connections:[{anchorId:film(99).id,anchorTitle:film(99).title,relation:'ai_inference',why:'A curatorial reading.',sourceIds:[]}]});
const ids=(recs:Recommendation[])=>recs.map(rec=>rec.film.id);
const proposals=Array.from({length:48},(_,i)=>recommendation(i));

test('regeneration excludes every previously shown film, including the previous batch when omitted from seenIds',()=>{
 const seen=ids(proposals.slice(0,12)),previous=ids(proposals.slice(12,24));
 const result=selectFreshRecommendations(proposals,[film(24).id],seen,previous,'regenerate');
 assert.deepEqual(ids(result),ids(proposals.slice(25,37)));
 assert.ok(validateFreshRecommendations(result,[film(24).id],seen,previous,'regenerate').valid);
});

for(const intent of ['follow','manual'] as const){
 test(`${intent} keeps at least seven of twelve films different from the immediately previous batch`,()=>{
  const previous=ids(proposals.slice(0,12));
  const result=selectFreshRecommendations(proposals,[film(0).id],ids(proposals.slice(0,24)),previous,intent);
  assert.deepEqual(ids(result),[...ids(proposals.slice(1,6)),...ids(proposals.slice(12,19))]);
  assert.deepEqual(validateFreshRecommendations(result,[film(0).id],[],previous,intent),{valid:true,issues:[],freshCount:7,overlapCount:5});
 });
}

test('freshness filtering preserves curator order and removes duplicates and selected films',()=>{
 const pool=[recommendation(8),recommendation(2),recommendation(8),recommendation(0),recommendation(6)];
 assert.deepEqual(ids(selectFreshRecommendations(pool,[film(0).id],[],[],'initial')),ids([pool[0],pool[1],pool[4]]));
});

test('scarce candidates produce an honest shorter majority-new batch rather than breaking freshness',()=>{
 const previous=ids(proposals.slice(0,12));
 const result=selectFreshRecommendations(proposals.slice(0,15),[],[],previous,'follow');
 assert.deepEqual(ids(result),[...ids(proposals.slice(0,2)),...ids(proposals.slice(12,15))]);
 assert.equal(validateFreshRecommendations(result,[],[],previous,'follow').valid,false);
 assert.equal(validateFreshRecommendations(result,[],[],previous,'follow',12,false).valid,true);
 assert.deepEqual(selectFreshRecommendations(proposals.slice(0,12),[],[],previous,'follow'),[]);
});

test('shared validation rejects repeats, selected movies, duplicates and exactly half-fresh updates',()=>{
 const previous=ids(proposals.slice(0,12));
 const half=[...proposals.slice(0,6),...proposals.slice(12,18)];
 assert.deepEqual(validateFreshRecommendations(half,[],[],previous,'manual').issues,['insufficient_fresh_films']);
 assert.ok(validateFreshRecommendations(proposals.slice(0,12),[],previous,[],'regenerate').issues.includes('previously_seen_film'));
 assert.ok(validateFreshRecommendations(proposals.slice(0,12),[film(0).id],[],[],'initial').issues.includes('selected_film'));
 assert.ok(validateFreshRecommendations(Array(12).fill(recommendation(0)),[],[],[],'initial').issues.includes('duplicate_films'));
});

test('cache identity includes action, response language, previous batch and archived exclusions',()=>{
 const options={intent:'regenerate' as const,previousIds:[film(1).id],language:'ko' as const};
 const key=discoveryCacheKey('curator',[film(0).id],[],[],options,[film(2).id]);
 assert.notEqual(key,discoveryCacheKey('curator',[film(0).id],[],[],{...options,language:'en'},[film(2).id]));
 assert.notEqual(key,discoveryCacheKey('curator',[film(0).id],[],[],{...options,intent:'follow'},[film(2).id]));
 assert.notEqual(key,discoveryCacheKey('curator',[film(0).id],[],[],{...options,previousIds:[]},[film(2).id]));
 assert.notEqual(key,discoveryCacheKey('curator',[film(0).id],[],[],options,[film(3).id]));
});

test('legacy ranking gives no automatic reward for citation labels or counting links',()=>{
 const plain=recommendation(0),edge=plain.connections[0];
 const cited={...recommendation(1),sourceIds:['source'],connections:[{...edge,relation:'direct_connection' as const,sourceIds:['source']}]};
 const multiple={...plain,connections:[edge,{...edge,anchorId:film(98).id}]};
 assert.equal(connectionScore(plain,[film(99),film(98)],[]),connectionScore(cited,[film(99),film(98)],[]));
 assert.equal(connectionScore(plain,[film(99),film(98)],[]),connectionScore(multiple,[film(99),film(98)],[]));
 assert.equal(rankRecommendations([plain,cited],[film(99)],[],[],1)[0].film.id,plain.film.id);
});
