import assert from 'node:assert/strict';
import test from 'node:test';
import {checkOrigin} from '../lib/server/config';

test('same-origin local requests use Host instead of Next internal localhost',()=>{
 assert.doesNotThrow(()=>checkOrigin(new Request('http://localhost:5174/api/recommendations',{headers:{host:'127.0.0.1:5174',origin:'http://127.0.0.1:5174'}})));
});
test('same-origin HTTPS proxy requests retain the external scheme',()=>{
 assert.doesNotThrow(()=>checkOrigin(new Request('http://internal:3000/api/recommendations',{headers:{host:'strada.example',origin:'https://strada.example','x-forwarded-proto':'https'}})));
});
test('cross-origin requests cannot spoof a matching forwarded host',()=>{
 assert.throws(()=>checkOrigin(new Request('https://strada.example/api/recommendations',{headers:{host:'strada.example',origin:'https://evil.example','x-forwarded-host':'evil.example'}})),/must come from STRADA/);
});
test('fallback URL origin remains enforced and originless server clients work',()=>{
 assert.doesNotThrow(()=>checkOrigin(new Request('https://strada.example/api/recommendations',{headers:{origin:'https://strada.example'}})));
 assert.doesNotThrow(()=>checkOrigin(new Request('https://strada.example/api/recommendations')));
 assert.throws(()=>checkOrigin(new Request('https://strada.example/api/recommendations',{headers:{origin:'null'}})),/must come from STRADA/);
});
