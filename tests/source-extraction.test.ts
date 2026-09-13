import test from 'node:test';
import assert from 'node:assert/strict';
import {extractSourceHtml,filmMentioned,readSourceDocument} from '../lib/server/grounding';

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
 assert.equal(filmMentioned(result.text,{title:'Close-Up'}),true);
});

test('article extraction skips active or ancillary content while retaining nested prose',()=>{
 const result=extractSourceHtml(`<article><p>Before<em>hand</em>.</p><script>danger()</script>
 <style>.hidden{}</style><nav>Navigation</nav><aside>Advertising</aside><footer>Footer</footer>
 <form>Subscribe</form><svg><text>Icon</text></svg><template>Template</template><noscript>Enable JavaScript</noscript>
 <article><p>Nested criticism.</p></article><p>After the nested article.</p></article>`);
 assert.equal(result.text,'Beforehand. Nested criticism. After the nested article.');
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
