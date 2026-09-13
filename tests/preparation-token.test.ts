import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {PREPARATION_TOKEN_LIMIT,PREPARATION_TTL,issuePreparationToken,readPreparationToken,type Preparation} from '../lib/server/preparation-token';

const TEST_KEY='strada-preparation-test-signing-key-never-sent';
const FINGERPRINT='curator-config-and-prompts-v3';
const selected={id:'tmdb:111',title:'Selected Film',titleKo:'선택한 영화',originalTitle:'Original Selected Film',year:1952,director:'Selected Director',poster:'https://image.tmdb.org/t/p/w500/selected.jpg'};
const second={...selected,id:'tmdb:222',title:'Another Selection',year:1959};
const candidate={...selected,id:'tmdb:333',title:'Another Film',year:1965};
function preparation():Preparation{return {
 version:1,issued:Date.now(),fingerprint:FINGERPRINT,language:'ko',selected:[selected,second],
 lenses:[{id:'l1',label:'A concrete formal question',question:'How do framing and duration differently organize the spectator?',anchors:['a0','a1']}],
 queries:[{query:'Selected Film framing duration criticism',anchors:['a0'],purpose:'anchor'}],
 candidates:[{code:'c0',film:candidate,draft:{title:candidate.title,year:candidate.year,director:candidate.director,lens:'l1',anchors:['a0','a1'],bridge:'A specific, provisional connection across cinematic forms.',contrast:'A productive difference.',check:'Check the precise formal observation.'}}],
 references:[{source:{id:'https://www.filmcomment.com/article/test-preparation',title:'A substantive essay',publisher:'Film Comment',author:'A Critic',date:null,url:'https://www.filmcomment.com/article/test-preparation',type:'criticism',scope:'interpretive_context',summary:'An observation about the selected film.',accessLevel:'full_text'},text:'This is the actual retrieved passage. Its punctuation, “quotation marks,” and paragraph context must remain readable.\n\nThe critic describes a specific formal operation.',anchorIds:[selected.id],purpose:'anchor',query:'Selected Film framing duration criticism'}],
 coveredFilmIds:[selected.id],
};}
function isolate(t:{after:(fn:()=>void)=>void}){
 const originalKey=process.env.OPENAI_API_KEY,originalFetch=globalThis.fetch;
 process.env.OPENAI_API_KEY=TEST_KEY;globalThis.fetch=async()=>{throw new Error('Preparation token tests must never access the network.');};
 t.after(()=>{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;});
}
function signedBody(body:string){return body+'.'+createHmac('sha256',TEST_KEY).update('strada-preparation-v1:'+body).digest('base64url');}
function signed(packet:unknown){return signedBody(gzipSync(JSON.stringify(packet)).toString('base64url'));}
function read(token:string|undefined,films=[selected,second],language='ko',fingerprint=FINGERPRINT){return readPreparationToken(token,films,language,fingerprint);}

test('a signed preparation preserves verified identities and exact reference text without serializing credentials',t=>{
 isolate(t);const packet=preparation(),token=issuePreparationToken({...packet,openai:TEST_KEY} as Preparation);assert.ok(token);
 const body=gunzipSync(Buffer.from(token.split('.')[0],'base64url')).toString('utf8'),decoded=JSON.parse(body);
 assert.equal(body.includes(TEST_KEY),false);assert.equal('openai' in decoded,false);
 assert.equal(decoded.references[0].text,packet.references[0].text);
 assert.deepEqual(read(token),packet);assert.equal(read(token)?.selected[0].titleKo,'선택한 영화');
});

test('preparation is bound to the complete selected-film set, language and model/prompt fingerprint',t=>{
 isolate(t);const token=issuePreparationToken(preparation());assert.ok(token);
 assert.ok(read(token,[second,selected]));
 assert.equal(read(token,[selected]),null);assert.equal(read(token,[selected,candidate]),null);assert.equal(read(token,[selected,second,candidate]),null);
 assert.equal(read(token,[selected,selected]),null);assert.equal(read(token,[selected,second],'en'),null);
 assert.equal(read(token,[selected,second],'ko','different-curator-or-prompt'),null);
});

test('an exhausted pool still carries verified readings, and subset mode accepts only an expanded selection',t=>{
 isolate(t);const packet=preparation(),token=issuePreparationToken({...packet,candidates:[]});assert.ok(token);
 assert.deepEqual(read(token)?.candidates,[]);assert.equal(read(token)?.references[0].text,packet.references[0].text);
 assert.equal(read(token,[selected,second,candidate]),null);
 assert.ok(readPreparationToken(token,[selected,second,candidate],'ko',FINGERPRINT,true));
 assert.equal(readPreparationToken(token,[selected,candidate],'ko',FINGERPRINT,true),null);
 assert.equal(readPreparationToken(token,[selected,second,candidate],'en',FINGERPRINT,true),null);
 assert.equal(readPreparationToken(token,[selected,second,candidate],'ko','another-draft',true),null);
});

test('body and signature tampering, malformed structure and signing-key rotation are rejected',t=>{
 isolate(t);const token=issuePreparationToken(preparation())!;const [body,signature]=token.split('.');
 const changed=preparation();changed.candidates[0].film={...candidate,title:'An injected identity'};
 assert.equal(read(gzipSync(JSON.stringify(changed)).toString('base64url')+'.'+signature),null);
 assert.equal(read(body+'.'+(signature[0]==='x'?'y':'x')+signature.slice(1)),null);
 for(const invalid of [undefined,'',body,token+'.extra',body+'.short','not-gzip.'+signature])assert.equal(read(invalid),null);
 process.env.OPENAI_API_KEY='a-different-signing-key';assert.equal(read(token),null);
 delete process.env.OPENAI_API_KEY;assert.equal(issuePreparationToken(preparation()),undefined);assert.equal(read(token),null);
});

test('preparation expires after six hours and rejects timestamps outside the allowed clock skew',t=>{
 isolate(t);const now=Date.now();t.mock.method(Date,'now',()=>now);const packet=preparation();
 assert.ok(read(signed({...packet,issued:now-PREPARATION_TTL})));
 assert.equal(read(signed({...packet,issued:now-PREPARATION_TTL-1})),null);
 assert.ok(read(signed({...packet,issued:now+60_000})));
 assert.equal(read(signed({...packet,issued:now+60_001})),null);
});

test('a new module instance can read the preparation without an in-memory registry',async t=>{
 isolate(t);const packet=preparation(),token=issuePreparationToken(packet);assert.ok(token);
 const freshPath='../lib/server/preparation-token.ts?independent-instance=preparation-token-test';
 const fresh=await import(freshPath) as typeof import('../lib/server/preparation-token');
 assert.notEqual(fresh.readPreparationToken,readPreparationToken);
 assert.deepEqual(fresh.readPreparationToken(token,[second,selected],'ko',FINGERPRINT),packet);
});

test('signed malformed reference and candidate data cannot bypass schema validation',t=>{
 isolate(t);const packet=preparation();
 for(const invalid of [
  {...packet,version:2},
  {...packet,selected:[]},
  {...packet,references:[{...packet.references[0],text:'x'.repeat(10_001)}]},
  {...packet,references:[{...packet.references[0],query:'x'.repeat(601)}]},
  {...packet,references:[{...packet.references[0],source:{...packet.references[0].source,url:'http://unsafe.example/article'}}]},
 ])assert.equal(read(signed(invalid)),null);
});

test('token length and decompressed payload bounds reject oversized input and issuance',t=>{
 isolate(t);assert.equal(read('x'.repeat(PREPARATION_TOKEN_LIMIT+1)),null);
 const incompressible=preparation();incompressible.selected[0]={...selected,overviewEn:randomBytes(250_000).toString('base64')};
 assert.equal(issuePreparationToken(incompressible),undefined);
 const highlyCompressible=preparation();highlyCompressible.selected[0]={...selected,overviewEn:'a'.repeat(1_000_001)};
 assert.ok(issuePreparationToken(highlyCompressible)===undefined,'Never issue a token that exceeds the reader decompression bound.');
 const bomb=signedBody(gzipSync(' '.repeat(1_000_001)).toString('base64url'));
 assert.ok(bomb.length<PREPARATION_TOKEN_LIMIT);assert.equal(read(bomb),null);
});
