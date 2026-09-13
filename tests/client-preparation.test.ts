import test from 'node:test';
import assert from 'node:assert/strict';
import {PreparationManager,discoveryInput,preparationKey,type PreparationInput} from '../lib/client/preparation';
import {EMPTY_SESSION,MAX_SESSION_STORAGE_CHARS,commitSnapshot,parseSession,type Film,type Snapshot} from '../lib/domain';
import {discoveryHistoryContext} from '../lib/discovery-context';
const film:Film={id:'tmdb:1',title:'Film',year:2000,director:'Director',poster:''};
const input=(overrides:Partial<PreparationInput>={}):PreparationInput=>({...discoveryInput({...EMPTY_SESSION,seedDraft:[film]},'ko','initial'),...overrides});
function deferredRequest(){
 const calls:{input:PreparationInput,signal:AbortSignal,resolve:(response:Response)=>void}[]=[];
 const fetcher:typeof fetch=(_url,init)=>new Promise<Response>((resolve,reject)=>{
  const signal=init!.signal as AbortSignal;
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  calls.push({input:JSON.parse(init!.body as string),signal,resolve});
 });
 const finish=(index:number,token=`prepared-${index}`)=>calls[index].resolve(Response.json({requestId:calls[index].input.requestId,baseSnapshotId:calls[index].input.baseSnapshotId,preparationToken:token,reserveCount:12}));
 return {calls,fetcher,finish};
}
test('foreground joins exact background preparation without another request or cleanup abort',async()=>{
 const mock=deferredRequest(),manager=new PreparationManager(mock.fetcher),request=input();
 const background=manager.prepare(request),foreground=manager.adopt({...request,requestId:'foreground-id'},new AbortController().signal);
 manager.cancelUnadopted();assert.equal(mock.calls.length,1);assert.equal(mock.calls[0].signal.aborted,false);
 mock.finish(0);assert.deepEqual(await foreground,await background);assert.equal((await foreground)?.preparationToken,'prepared-0');
});
test('changed selection cancels old speculation and cannot use its result',async()=>{
 const mock=deferredRequest(),manager=new PreparationManager(mock.fetcher),first=input(),second=input({seeds:['tmdb:2']});
 const old=manager.prepare(first),next=manager.prepare(second);assert.equal(mock.calls[0].signal.aborted,true);
 assert.equal(await manager.adopt(first,new AbortController().signal),undefined);
 mock.finish(1);assert.equal((await next)?.preparationToken,'prepared-1');assert.equal(await old,undefined);
});
test('foreground cancellation aborts adopted preparation',async()=>{
 const mock=deferredRequest(),manager=new PreparationManager(mock.fetcher),request=input(),controller=new AbortController();
 void manager.prepare(request);const adopted=manager.adopt(request,controller.signal);controller.abort();
 assert.equal(mock.calls[0].signal.aborted,true);assert.equal(await adopted,undefined);
});
test('preparation failure and wrong response context quietly permit direct fallback',async()=>{
 const request=input(),manager=new PreparationManager(async()=>Response.json({requestId:'other',baseSnapshotId:null,preparationToken:'bad',reserveCount:12}));
 assert.equal(await manager.prepare(request),undefined);assert.equal(await manager.adopt(request,new AbortController().signal),undefined);
 const unavailable=new PreparationManager(async()=>new Response('',{status:503}));assert.equal(await unavailable.prepare(request),undefined);
});
test('reuse keys include history, action, language and snapshot; request IDs do not matter',()=>{
 const original=input();assert.equal(preparationKey(original),preparationKey({...original,requestId:'other'}));
 for(const change of [{language:'en' as const},{seenIds:['tmdb:3']},{intent:'regenerate' as const},{baseSnapshotId:'different'},{previousIds:['tmdb:4']}])assert.notEqual(preparationKey(original),preparationKey({...original,...change}));
});
test('completed preparation cache keeps only the last three distinct contexts',async()=>{
 let calls=0;const manager=new PreparationManager(async(_url,init)=>{calls++;const body=JSON.parse(init!.body as string);return Response.json({requestId:body.requestId,baseSnapshotId:body.baseSnapshotId,preparationToken:`token-${calls}`,reserveCount:12});});
 const requests=[1,2,3,4].map(i=>input({seeds:[`tmdb:${i}`]}));for(const request of requests)await manager.prepare(request);
 assert.equal(await manager.adopt(requests[0],new AbortController().signal),undefined);
 assert.equal((await manager.adopt(requests[3],new AbortController().signal))?.preparationToken,'token-4');assert.equal(calls,4);
});
test('cancelled foreground context does not automatically restart paid preparation',async()=>{
 let calls=0;const request=input(),manager=new PreparationManager(async(_url,init)=>{calls++;const body=JSON.parse(init!.body as string);return Response.json({requestId:body.requestId,baseSnapshotId:body.baseSnapshotId,preparationToken:'prepared',reserveCount:12});});
 manager.suppress(preparationKey(request));assert.equal(await manager.prepare(request),undefined);assert.equal(calls,0);
 await manager.adopt(request,new AbortController().signal);await manager.prepare(request);assert.equal(calls,1);
});

test('maximum portable pool tokens survive browser persistence while trimmed history keeps all exclusions',()=>{
 let session=EMPTY_SESSION;
 for(let step=0;step<10;step++){
  const snapshot:Snapshot={id:`snapshot-${step}`,createdAt:'2026-09-13T00:00:00Z',seeds:[film],trail:[],sources:[],mode:'live',preparationToken:'x'.repeat(220000),reserveCount:12,recommendations:Array.from({length:12},(_,index)=>({film:{...film,id:`tmdb:${100+step*12+index}`},connections:[{anchorId:film.id,anchorTitle:film.title,relation:'ai_inference',why:'A relationship.',sourceIds:[]}],sourceIds:[],detailToken:'x'.repeat(16000)}))};
  session=commitSnapshot(session,snapshot,step===0);
 }
 const serialized=JSON.stringify(session),restored=parseSession(serialized);
 assert.ok(serialized.length<=MAX_SESSION_STORAGE_CHARS);
 assert.ok(restored.snapshots.length<10);
 assert.equal(restored.snapshots.at(-1)?.preparationToken?.length,220000);
 assert.equal(restored.snapshots.at(-1)?.reserveCount,12);
 assert.equal(discoveryHistoryContext(restored,true).seenIds.length,120);
});

test('continuing requests carry the parent source packet even with an exhausted candidate reserve',()=>{
 const snapshot:Snapshot={id:'parent',createdAt:'2026-09-13T00:00:00Z',seeds:[film],trail:[],sources:[],mode:'live',preparationToken:'parent-sources',reserveCount:0,recommendations:[{film:{...film,id:'tmdb:2'},connections:[{anchorId:film.id,anchorTitle:film.title,relation:'ai_inference',why:'A relationship.',sourceIds:[]}],sourceIds:[]}]};
 const session=commitSnapshot(EMPTY_SESSION,snapshot,true);
 assert.equal(discoveryInput(session,'ko','initial').preparationToken,undefined);
 for(const intent of ['regenerate','follow','manual'] as const){
  const request=discoveryInput(session,'ko',intent,intent==='regenerate'?undefined:{...film,id:'tmdb:3'});
  assert.equal(request.preparationToken,'parent-sources');
  assert.equal(preparationKey(request),preparationKey({...request,preparationToken:'replacement-sources'}));
 }
});
test('a prepared source packet is retained when its remaining candidate count is zero',async()=>{
 const request=input(),manager=new PreparationManager(async(_url,init)=>{const body=JSON.parse(init!.body as string);return Response.json({requestId:body.requestId,baseSnapshotId:body.baseSnapshotId,preparationToken:'sources-only',reserveCount:0});});
 assert.deepEqual(await manager.prepare(request),{preparationToken:'sources-only',reserveCount:0});
});
