import assert from 'node:assert/strict';
import test from 'node:test';
import {parseSession,type Film,type Session,type Source,type RunDiagnostics} from '../lib/domain';
import {refreshSavedEvidence} from '../lib/client/saved-evidence';

const seed:Film={id:'tmdb:1',title:'Selected Film',year:1980,director:'A Director',poster:''};
const trail:Film={id:'tmdb:2',title:'Followed Film',year:1990,director:'B Director',poster:''};
const abstract:Source={id:'old-abstract',title:'Abstract-only paper',publisher:'Test journal',author:null,date:null,url:'https://example.org/abstract',type:'academic',scope:'interpretive_context',summary:'A saved source reading.',accessLevel:'abstract'};
const full:Source={...abstract,id:'body-paper',title:'Full-text paper',url:'https://example.org/body',accessLevel:'full_page'};
const diagnostics=(version:string):RunDiagnostics=>({engine:'curator-literature-v2',model:'test',corpusVersion:version,documents:44,observations:52,retrievedDocuments:1,retrievedPassages:1,usedDocuments:1,coveredFilmIds:[seed.id],repairAttempted:false});
function saved(sources:Source[],corpusVersion?:string):Session{
 const sourceIds=sources.map(source=>source.id);
 return {version:2,seedDraft:[seed],cursor:0,archivedSeenIds:['tmdb:old'],snapshots:[{
  id:'saved-step',createdAt:'2026-09-20T00:00:00.000Z',seeds:[seed],trail:[trail],sources,mode:'live',...(corpusVersion?{diagnostics:diagnostics(corpusVersion)}:{}),
  recommendations:Array.from({length:12},(_,n)=>({film:{...seed,id:`tmdb:${n+100}`,title:`Recommendation ${n}`},sourceIds,detailToken:'old-signed-token',connections:[{anchorId:seed.id,anchorTitle:seed.title,relation:'direct_connection',why:'A saved connection.',sourceIds}]})),
 }]};
}

test('restoring an abstract-only route withdraws its citations and tokens while preserving every chosen film',()=>{
 const original=saved([abstract]),restored=refreshSavedEvidence(original),snapshot=restored.snapshots[0];
 assert.deepEqual(restored.seedDraft,original.seedDraft);assert.deepEqual(snapshot.seeds,original.snapshots[0].seeds);assert.deepEqual(snapshot.trail,original.snapshots[0].trail);
 assert.deepEqual(snapshot.recommendations.map(r=>r.film),original.snapshots[0].recommendations.map(r=>r.film));
 assert.deepEqual(restored.archivedSeenIds,original.archivedSeenIds);assert.equal(restored.cursor,0);
 assert.deepEqual(snapshot.sources,[]);
 for(const rec of snapshot.recommendations){assert.deepEqual(rec.sourceIds,[]);assert.equal(rec.connections[0].relation,'ai_inference');assert.deepEqual(rec.connections[0].sourceIds,[]);assert.equal(rec.detailToken,undefined);assert.equal(rec.contextScope,'discovery');}
 assert.equal(original.snapshots[0].sources.length,1,'restoration must not mutate the supplied session');
 assert.deepEqual(parseSession(JSON.stringify(restored)),restored);
});

test('mixed saved evidence keeps full text and removes only obsolete references',()=>{
 const restored=refreshSavedEvidence(saved([abstract,full]));
 assert.deepEqual(restored.snapshots[0].sources.map(s=>s.id),[full.id]);
 for(const rec of restored.snapshots[0].recommendations){assert.deepEqual(rec.sourceIds,[full.id]);assert.deepEqual(rec.connections[0].sourceIds,[full.id]);assert.equal(rec.connections[0].relation,'grounded_interpretation','surviving context cannot inherit a removed paper’s direct-evidence label');assert.equal(rec.detailToken,undefined);}
 assert.doesNotThrow(()=>parseSession(JSON.stringify(restored)));
});

test('a changed collection marks old evidence historical and removes unverified direct-connection privileges without erasing the route',()=>{
 const original=saved([full],'corpus-old'),restored=refreshSavedEvidence(original,'corpus-current');
 const snapshot=restored.snapshots[0];
 assert.equal(snapshot.evidenceStatus,'historical');assert.deepEqual(snapshot.sources,original.snapshots[0].sources);
 assert.deepEqual(snapshot.seeds,original.snapshots[0].seeds);assert.deepEqual(snapshot.trail,original.snapshots[0].trail);
 assert.equal(snapshot.recommendations.length,12);
 for(const rec of snapshot.recommendations){assert.equal(rec.connections[0].relation,'grounded_interpretation');assert.equal(rec.detailToken,'old-signed-token','the server independently checks each document version before expanding');}
 assert.equal(parseSession(JSON.stringify(restored)).snapshots[0].evidenceStatus,'historical');
 assert.equal(refreshSavedEvidence(saved([full]),'corpus-current').snapshots[0].evidenceStatus,'historical','pre-corpus saved routes also need the historical notice');
});

test('current saved full-text evidence and source-free paths do not acquire stale labels',()=>{
 const current=refreshSavedEvidence(saved([full],'corpus-current'),'corpus-current');
 assert.equal(current.snapshots[0].evidenceStatus,undefined);
 assert.equal(current.snapshots[0].recommendations[0].detailToken,'old-signed-token');
 const sourceFree=saved([],'corpus-current');
 for(const rec of sourceFree.snapshots[0].recommendations){rec.connections[0].relation='ai_inference';}
 const restored=refreshSavedEvidence(sourceFree,'corpus-current');
 assert.equal(restored.snapshots[0].evidenceStatus,undefined);assert.equal(restored.snapshots[0].recommendations.length,12);
 assert.doesNotThrow(()=>parseSession(JSON.stringify(restored)));
});
