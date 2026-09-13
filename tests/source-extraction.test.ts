import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {allowedPublicSourceUrl,isPublicSourceAddress,extractSourceHtml,filmMentioned,readSourceDocument,retrievedSources} from '../lib/server/grounding';

test('Node extracts article prose and metadata, decoding named and numeric entities',()=>{
 const result=extractSourceHtml(`<!doctype html><html><head><title>Fallback</title>
 <meta property=og:title content="Close&#x2D;Up &amp; cinema"><meta name=author content="Critic &amp; Writer">
 <meta property=article:published_time content=2026-09-12></head><body>
 <nav>Unrelated links</nav><main>Other text<article><h1>Close&#45;Up</h1>
 <p>It asks &ldquo;who is <em>performing</em>?&rdquo; &amp; why.</p>
 <p>춘향뎐&nbsp;and cinema.<br>Another line.</p></article>More unrelated text</main></body></html>`);
 assert.equal(result.title,'Close-Up & cinema');
 assert.equal(result.author,'Critic & Writer');
 assert.equal(result.date,'2026-09-12');
 assert.equal(result.text,'Close-Up It asks “who is performing?” & why. 춘향뎐 and cinema. Another line.');
 assert.deepEqual(result.paragraphs,['Close-Up','It asks “who is performing?” & why.','춘향뎐 and cinema.','Another line.']);
 assert.equal(filmMentioned(result.text,{title:'Close-Up'}),true);
});

test('article extraction skips active or ancillary content while retaining nested prose',()=>{
 const result=extractSourceHtml(`<article><p>Before<em>hand</em>.</p><script>danger()</script>
 <style>.hidden{}</style><nav>Navigation</nav><aside>Advertising</aside><footer>Footer</footer>
 <form>Subscribe</form><svg><text>Icon</text></svg><template>Template</template><noscript>Enable JavaScript</noscript>
 <article><p>Nested criticism.</p></article><p>After the nested article.</p></article>`);
 assert.equal(result.text,'Beforehand. Nested criticism. After the nested article.');
 assert.equal(extractSourceHtml('<article><a rel="author">By An Expert Critic</a><p>Film criticism.</p></article>').author,'An Expert Critic');
});

test('main and body fallbacks handle malformed HTML and deep nesting without recursion',()=>{
 assert.equal(extractSourceHtml('<title>Title &amp; author</title><nav>Links</nav><main><p>First<p>Second').text,'First Second');
 assert.equal(extractSourceHtml('<title>Title</title><body>Only the body<script>ignore me</script>').text,'Only the body');
 assert.equal(extractSourceHtml('<article>'+('<div>'.repeat(1500))+'Deep text'+('</div>'.repeat(1500))+'</article>').text,'Deep text');
 assert.equal(extractSourceHtml('<main>'+('x'.repeat(81000))+'</main>').text.length,80000);
});

test('readSourceDocument works in Node without HTMLRewriter and preserves film mention checks',async t=>{
 const prose='Boyhood follows a family over years, finding meaning in ordinary moments. '.repeat(10);
 const fetchMock=t.mock.method(globalThis,'fetch',async()=>new Response(`<title>Boyhood &amp; time</title><article>${prose}</article>`,{headers:{'Content-Type':'text/html; charset=utf-8'}}));
 const document=await readSourceDocument('https://www.filmcomment.com/node-extraction-test',{remaining:2},new AbortController().signal);
 assert.ok(document);assert.equal(document.title,'Boyhood & time');assert.equal(document.text,prose.trim());
 assert.equal(filmMentioned(document.text,{title:'Boyhood'}),true);assert.equal(fetchMock.mock.callCount(),1);
});

test('source fetch refuses a redirect outside the allowlist before requesting its target',async t=>{
 const fetchMock=t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}}));
 const document=await readSourceDocument('https://www.filmcomment.com/node-redirect-test',{remaining:3},new AbortController().signal);
 assert.equal(document,null);assert.equal(fetchMock.mock.callCount(),1);
});

test('source fetch retains its body size cap',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('x'.repeat(2_000_001),{headers:{'Content-Type':'text/html'}}));
 assert.equal(await readSourceDocument('https://www.filmcomment.com/node-size-test',{remaining:2},new AbortController().signal),null);
});

test('broader article eligibility rejects local URLs, ratings, shops and non-public socket addresses',()=>{
 for(const url of ['http://critic.example.net/essay','https://127.0.0.1/essay','https://[::1]/essay','https://critic.local/essay','https://author:password@critic.example.net/essay','https://critic.example.net:8443/essay','https://letterboxd.com/film/boyhood','https://critic.example.net/shop/posters'])assert.equal(allowedPublicSourceUrl(url),false,url);
 assert.equal(allowedPublicSourceUrl('https://another-film-journal.net/essays/domestic-ritual'),true);
 for(const address of ['0.0.0.0','127.0.0.1','10.2.3.4','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2001:0000:1234::1','2002:7f00:1::'])assert.equal(isPublicSourceAddress(address),false,address);
 assert.equal(isPublicSourceAddress('104.18.12.10'),true);assert.equal(isPublicSourceAddress('2606:4700::1111'),true);
 const output={output:[{type:'web_search_call',action:{sources:[{url:'https://another-film-journal.net/essays/domestic-ritual'},{url:'https://127.0.0.1/private'}]}}]};
 assert.equal(retrievedSources(output).length,0);assert.equal(retrievedSources(output,{allowPublicWeb:true}).length,1);
});

test('new publication sockets use checked DNS addresses and refuse mixed public/private answers',async t=>{
 let addresses=[{address:'104.18.12.10',family:4}],connected=0;
 t.mock.method(dns,'lookup',((_host:unknown,_options:unknown,callback:(error:null,addresses:unknown[])=>void)=>callback(null,addresses)) as typeof dns.lookup);
 t.mock.method(https,'request',((url:string,options:any,onResponse:(response:any)=>void)=>{
  const request=new EventEmitter() as EventEmitter&{end:()=>void,destroy:(error:Error)=>void};
  request.destroy=error=>{request.emit('error',error);};
  request.end=()=>options.lookup(new URL(url).hostname,{all:true},(error:Error|null,checked:unknown)=>{
   if(error){request.emit('error',error);return;}
   assert.deepEqual(checked,addresses);connected++;
   const response=Readable.from([Buffer.from('<article><p>'+('Film criticism discusses framing, ritual and social change. '.repeat(20))+'</p></article>')]) as Readable&{statusCode:number,headers:Record<string,string>};
   response.statusCode=200;response.headers={'content-type':'text/html'};onResponse(response);
  });return request;
 }) as typeof https.request);
 const first=await readSourceDocument('https://another-film-journal.net/essays/pinned-public',{remaining:2},new AbortController().signal,{allowPublicWeb:true});
 assert.ok(first);assert.equal(connected,1);
 addresses=[{address:'104.18.12.10',family:4},{address:'127.0.0.1',family:4}];
 const blocked=await readSourceDocument('https://another-film-journal.net/essays/mixed-private',{remaining:2},new AbortController().signal,{allowPublicWeb:true});
 assert.equal(blocked,null);assert.equal(connected,1);
});
