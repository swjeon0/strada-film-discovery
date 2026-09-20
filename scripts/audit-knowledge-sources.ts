import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir,readFile,readdir,rename,writeFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {parse,type DefaultTreeAdapterTypes} from 'parse5';

const EXTRACTOR_VERSION=3,CONCURRENCY=3,MAX_BYTES=32_000_000,TIMEOUT_MS=18_000,CACHE_MS=7*86_400_000;
const PDF_PYTHON=process.env.KNOWLEDGE_PDF_PYTHON??process.argv.find(arg=>arg.startsWith('--pdf-python='))?.slice('--pdf-python='.length)??'python3';
const execFileAsync=promisify(execFile);
const cacheRoot=resolve('work/knowledge/source-cache');
type RecordInput={id:string;url:string;verification?:{textUrl?:string};passages:{id:string;text:string;locator:string}[]};
type Status='matched'|'quote_missing'|'blocked'|'network_error'|'http_error'|'pdf_not_checked'|'unsupported_content'|'response_too_large'|'unreadable'|'invalid_url';
type FetchResult={status:Status|'readable';url:string;httpStatus:number|null;checkedAt:string;contentHash:string|null;textHash?:string;contentType?:string;text?:string;reason?:string;fromCache?:boolean;bytes?:number};
type QuoteResult={passageId:string;status:'matched'|'quote_missing'|'not_checked';matchMode?:'exact'|'typography_normalized';offset?:number;offsetBasis?:'extracted_text'|'normalized_text';locator:string};
type AuditRow={documentId:string;url:string;checkedUrl:string;httpStatus:number|null;status:Status;checkedAt:string;contentHash:string|null;textHash?:string;contentType?:string;bytes?:number;fromCache:boolean;reason?:string;quotes:QuoteResult[]};
const OMIT=new Set(['script','style','nav','footer','aside','svg','form','noscript','template','head']);
const BLOCK=new Set(['article','main','p','div','h1','h2','h3','h4','h5','h6','li','section','blockquote','br','hr','td','th','tr','ul','ol']);

// Retain punctuation and diacritics: a match must still be the quoted words in order.
export function normalizeQuote(text:string){return text.normalize('NFKC').replace(/\u00ad/g,'').replace(/-\r?\n(?=\p{L})/gu,'').replace(/[‘’‚‛ʼ`]/g,"'").replace(/[“”„‟]/g,'"').replace(/[‐‑‒–—−]/g,'-').replace(/\s+/g,' ').trim();}
export function extractAuditText(html:string,requestedFragment=''){
 const document=parse(html),parts:string[]=[],linkedSections=new Set<string>();
 if(requestedFragment)linkedSections.add(requestedFragment);
 // Public transcripts may be initially collapsed, but explicitly reachable through a
 // "Read transcript" anchor. Include that source text, not arbitrary hidden content.
 function findLinks(node:DefaultTreeAdapterTypes.Node){
  if('tagName' in node&&node.tagName==='a'){const href=node.attrs.find(a=>a.name==='href')?.value;if(href?.startsWith('#')&&href.length>1)linkedSections.add(href.slice(1));}
  if('childNodes' in node)for(const child of node.childNodes)findLinks(child);
 }
 findLinks(document);
 function visit(node:DefaultTreeAdapterTypes.Node){
  if(node.nodeName==='#text'&&'value' in node){parts.push(node.value);return;}
  if('tagName' in node){
   const hidden=node.attrs.some(a=>a.name==='hidden'||a.name==='aria-hidden'&&a.value==='true');
   const linked=node.attrs.some(a=>a.name==='id'&&linkedSections.has(a.value));
   if(OMIT.has(node.tagName)||hidden&&!linked)return;
   if(BLOCK.has(node.tagName))parts.push('\n');
  }
  if('childNodes' in node)for(const child of node.childNodes)visit(child);
  if('tagName' in node&&BLOCK.has(node.tagName))parts.push('\n');
 }
 visit(document);
 return parts.join('').replace(/[\t \u00a0]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function quoteCheck(text:string,passage:RecordInput['passages'][number]):QuoteResult{
 const base={passageId:passage.id,locator:passage.locator};
 if(!passage.text.trim())return {...base,status:'quote_missing'};
 const exact=text.indexOf(passage.text);
 if(exact>=0)return {...base,status:'matched',matchMode:'exact',offset:exact,offsetBasis:'extracted_text'};
 const offset=normalizeQuote(text).indexOf(normalizeQuote(passage.text));
 return offset>=0?{...base,status:'matched',matchMode:'typography_normalized',offset,offsetBasis:'normalized_text'}:{...base,status:'quote_missing'};
}
export function sourceUrlAllowed(raw:string){try{
 const u=new URL(raw),host=u.hostname.toLowerCase();
 return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!isIP(host.replace(/^\[|\]$/g,''))&&host.includes('.')&&!/(?:^|\.)(?:localhost|local|internal|test|invalid|example|nip\.io|sslip\.io)$/.test(host);
}catch{return false;}}
const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
async function pdfText(pdfPath:string,txtPath:string){
 try{await execFileAsync('pdftotext',['-enc','UTF-8',pdfPath,txtPath],{timeout:15_000,maxBuffer:1_000_000});}
 catch{
  // A configurable interpreter keeps bundled local dependencies out of production paths.
  const code="from pypdf import PdfReader\nfrom pathlib import Path\nimport sys\nr=PdfReader(sys.argv[1])\nif len(r.pages)>250: raise ValueError('PDF page limit exceeded')\nPath(sys.argv[2]).write_text('\\n\\n'.join(page.extract_text() or '' for page in r.pages),encoding='utf-8')\n";
  await execFileAsync(PDF_PYTHON,['-c',code,pdfPath,txtPath],{timeout:15_000,maxBuffer:1_000_000});
 }
 return readFile(txtPath,'utf8');
}
async function atomic(path:string,data:unknown){await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(data,null,2)+'\n');await rename(path+'.tmp',path);}
function isChallenge(text:string){return /(?:just a moment|checking your browser|verify you are human|enable javascript and cookies to continue|access denied|attention required!.*cloudflare)/i.test(text.slice(0,2500));}
async function boundedBody(response:Response){
 const length=Number(response.headers.get('content-length')??0);
 if(length>MAX_BYTES){await response.body?.cancel();throw new Error('response_too_large');}
 const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
 const parts:Uint8Array[]=[],cancel=()=>reader.cancel().catch(()=>{});let bytes=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES){await cancel();throw new Error('response_too_large');}parts.push(value);}}
 finally{reader.releaseLock();}
 return Buffer.concat(parts);
}
async function fetchOnce(raw:string):Promise<FetchResult>{
 let url=raw;
 const checkedAt=new Date().toISOString(),signal=AbortSignal.timeout(TIMEOUT_MS);
 const base={checkedAt,contentHash:null,httpStatus:null};
 try{
  for(let redirects=0;redirects<5;redirects++){
   if(!sourceUrlAllowed(url))return {...base,url,status:'invalid_url',reason:'Only public HTTPS publisher URLs without credentials or custom ports are accepted.'};
   const response=await fetch(url,{redirect:'manual',signal,headers:{'User-Agent':'STRADA-source-audit/1.0 (bounded citation verification)','Accept':'text/html,application/pdf,text/plain;q=0.8'}});
   if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location)return {...base,url,httpStatus:response.status,status:'http_error',reason:'Redirect has no location.'};url=new URL(location,url).href;continue;}
   if(!response.ok){await response.body?.cancel();return {...base,url,httpStatus:response.status,status:[401,403,429].includes(response.status)?'blocked':'http_error',reason:`Publisher returned HTTP ${response.status}. Quote presence was not assessed.`};}
   const body=await boundedBody(response),contentType=response.headers.get('content-type')??'',meta={checkedAt,url,httpStatus:response.status,contentType,contentHash:hash(body),bytes:body.byteLength};
   let text:string;
   if(contentType.includes('application/pdf')||body.subarray(0,5).toString()==='%PDF-'){
    const pdfPath=join(cacheRoot,`${hash(body)}.pdf`),txtPath=join(cacheRoot,`${hash(body)}.txt`);
    await mkdir(cacheRoot,{recursive:true});await writeFile(pdfPath,body);
    try{text=await pdfText(pdfPath,txtPath);}
    catch{return {...meta,status:'pdf_not_checked',reason:'Neither pdftotext nor the configured Python/pypdf converter completed. Original PDF fetched, but quotes were not checked. Set KNOWLEDGE_PDF_PYTHON or --pdf-python to an installed interpreter.'};}
   }else if(contentType.includes('html'))text=extractAuditText(body.toString('utf8'),new URL(raw).hash.slice(1));
   else if(contentType.includes('text/plain'))text=body.toString('utf8');
   else return {...meta,status:'unsupported_content',reason:'Response is not HTML, plain text, or PDF. Quotes were not checked.'};
   if(isChallenge(text))return {...meta,status:'blocked',reason:'Publisher delivered a browser/access challenge. Quote presence was not assessed.'};
   if(text.trim().length<80)return {...meta,status:'unreadable',reason:'Too little extracted text to assess quote presence.'};
   return {...meta,status:'readable',text,textHash:hash(text)};
  }
  return {...base,url,status:'http_error',reason:'Redirect limit reached. Quotes were not checked.'};
 }catch(error){return {...base,url,status:error instanceof Error&&error.message==='response_too_large'?'response_too_large':'network_error',reason:error instanceof Error&&error.message==='response_too_large'?`Response exceeds ${MAX_BYTES} bytes. Quotes were not checked.`:'Network request failed or timed out. Quote presence was not assessed.'};}
}
async function readSource(url:string,refresh:boolean):Promise<FetchResult>{
 const cachePath=join(cacheRoot,`${hash(url)}.json`);
 if(!refresh)try{const cached=JSON.parse(await readFile(cachePath,'utf8')) as FetchResult&{extractorVersion:number};if(cached.extractorVersion===EXTRACTOR_VERSION&&cached.status==='readable'&&cached.text&&hash(cached.text)===cached.textHash&&Date.now()-Date.parse(cached.checkedAt)<CACHE_MS)return {...cached,fromCache:true};}catch{}
 let result=await fetchOnce(url);
 // Do not retry denial/rate-limit pages; only a transient network/server failure gets one retry.
 if(result.status==='network_error'||result.status==='http_error'&&(result.httpStatus??0)>=500){await new Promise(resolve=>setTimeout(resolve,650));result=await fetchOnce(url);}
 if(result.status==='readable')await atomic(cachePath,{...result,extractorVersion:EXTRACTOR_VERSION});
 return {...result,fromCache:false};
}
export async function auditRecord(record:RecordInput,load:(url:string)=>Promise<FetchResult>):Promise<AuditRow>{
 const result=await load(record.verification?.textUrl??record.url);
 const quotes=result.status==='readable'?record.passages.map(p=>quoteCheck(result.text!,p)):record.passages.map(p=>({passageId:p.id,locator:p.locator,status:'not_checked' as const}));
 return {documentId:record.id,url:record.url,checkedUrl:result.url,httpStatus:result.httpStatus,status:result.status==='readable'?(quotes.length&&quotes.every(q=>q.status==='matched')?'matched':'quote_missing'):result.status,checkedAt:result.checkedAt,contentHash:result.contentHash,textHash:result.textHash,contentType:result.contentType,bytes:result.bytes,fromCache:result.fromCache??false,reason:result.reason??(quotes.some(q=>q.status==='quote_missing')?'Quote not located in extracted response. Review changed publisher wording or omitted dynamic/transcript content.':undefined),quotes};
}
async function main(){
 const root=resolve('research/knowledge/records'),names=(await readdir(root)).filter(name=>name.endsWith('.json')).sort(),records:RecordInput[]=[];
 for(const name of names)records.push(...JSON.parse(await readFile(join(root,name),'utf8')) as RecordInput[]);
 if(new Set(records.map(r=>r.id)).size!==records.length)throw new Error('Duplicate document IDs; audit stopped.');
 const refresh=process.argv.includes('--refresh'),results:AuditRow[]=new Array(records.length);let cursor=0;
 await Promise.all(Array.from({length:CONCURRENCY},async()=>{while(cursor<records.length){const index=cursor++,record=records[index];results[index]=await auditRecord(record,url=>readSource(url,refresh));console.log(`${record.id}: ${results[index].status}`);}}));
 const counts=results.reduce<Record<string,number>>((acc,row)=>(acc[row.status]=(acc[row.status]??0)+1,acc),{});
 await atomic(resolve('research/knowledge/source-audit.json'),{version:1,extractorVersion:EXTRACTOR_VERSION,generatedAt:new Date().toISOString(),corpusRecordsHash:hash(JSON.stringify(records)),documentCount:records.length,counts,notes:['Quote matching checks text presence only, not interpretive entailment or rights clearance.','Normalized offsets refer to typography-normalized extracted text; exact offsets refer to extracted text.','Cached sources retain the original fetch checkedAt. Full source text is only in ignored work/knowledge/source-cache.'],documents:results});
 console.log(JSON.stringify({documents:records.length,counts,report:'research/knowledge/source-audit.json'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error instanceof Error?error.message:'Source audit failed.');process.exitCode=1;});
