import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import nextEnv from '@next/env';
import {observationKey,type KnowledgeIndex,type SemanticNeighbors} from '../lib/server/knowledge/types';

const MODEL='text-embedding-3-small',DIMENSIONS=256;
type Cache={model:string;dimensions:number;vectors:Record<string,number[]>;generatedAt?:Record<string,string>};
export function embeddingRows(index:KnowledgeIndex){return index.documents.flatMap(document=>document.observations.filter(o=>o.kind!=='incidental_mention').map(observation=>{
 const text=[observation.summary,observation.summaryKo??'',...observation.subjects,`Scope: ${observation.boundary}`].join('\n');
 return {id:observationKey(document.id,observation.id),hash:createHash('sha256').update(`${MODEL}:${DIMENSIONS}:${text}`).digest('hex'),text};
}));}
export function nearestNeighbors(rows:{id:string;vector:number[]}[],count=10):SemanticNeighbors['neighbors']{
 const norm=(v:number[])=>Math.sqrt(v.reduce((sum,x)=>sum+x*x,0));
 const vectors=rows.map(row=>{const length=norm(row.vector);return {...row,vector:row.vector.map(x=>length?x/length:0)};});
 // Exact below 512 observations; bounded deterministic LSH candidates above
 // that size avoid rebuilding an all-pairs O(n²) graph as literature grows.
 let randomState=3719;const random=()=>{randomState^=randomState<<13;randomState^=randomState>>>17;randomState^=randomState<<5;return (randomState>>>0)/4294967296-0.5;};
 const planes=Array.from({length:48},()=>Array.from({length:rows[0]?.vector.length??0},random));
 const signatures=vectors.length>512?vectors.map(row=>Array.from({length:4},(_,band)=>planes.slice(band*12,band*12+12).reduce((bits,plane,bit)=>bits|(row.vector.reduce((sum,x,i)=>sum+x*plane[i],0)>=0?1<<bit:0),0))):[];
 const buckets=new Map<string,number[]>();for(const [i,signature] of signatures.entries())for(const [band,bits] of signature.entries()){const key=`${band}:${bits}`;const bucket=buckets.get(key)??[];bucket.push(i);buckets.set(key,bucket);}
 return Object.fromEntries(vectors.map((row,i)=>{
  let pool=vectors;
  if(signatures.length){const candidates=new Set<number>();for(let distance=0;distance<2;distance++)for(const [band,bits] of signatures[i].entries())for(let bit=0;bit<(distance?12:1);bit++){for(const index of buckets.get(`${band}:${distance?bits^(1<<bit):bits}`)??[]){if(candidates.size>=768)break;candidates.add(index);}}pool=[...candidates].map(index=>vectors[index]);}
  return [row.id,pool.filter(other=>other.id!==row.id).map(other=>({id:other.id,score:row.vector.reduce((sum,x,j)=>sum+x*other.vector[j],0)})).filter(other=>Number.isFinite(other.score)&&other.score>=0.48).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,count).map(other=>({...other,score:Number(other.score.toFixed(6))}))];
 }));
}
async function atomic(path:string,data:unknown){await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(data,null,2)+'\n');await rename(path+'.tmp',path);}
async function main(){
 nextEnv.loadEnvConfig(process.cwd());
 const args=process.argv.slice(2),run=args.includes('--run'),cacheOnly=args.includes('--cache-only'),index=JSON.parse(await readFile(resolve('research/knowledge/serving-index.json'),'utf8')) as KnowledgeIndex;
 const cachePath=resolve('work/knowledge/embeddings.json'),rows=embeddingRows(index);let cache:Cache={model:MODEL,dimensions:DIMENSIONS,vectors:{}};
 try{const saved=JSON.parse(await readFile(cachePath,'utf8')) as Cache;if(saved.model===MODEL&&saved.dimensions===DIMENSIONS)cache=saved;}catch{}
 const pending=[...new Map(rows.filter(row=>!cache.vectors[row.hash]).map(row=>[row.hash,row])).values()];
 if(!run){console.log(JSON.stringify({documents:index.documents.length,observations:rows.length,uncached:pending.length,model:MODEL,dimensions:DIMENSIONS,apiCalls:0,hint:'Use --run to embed new or changed annotations only.'},null,2));return;}
 if(cacheOnly&&pending.length)throw new Error(`Cache-only embedding build has ${pending.length} uncached inputs; no API request was made.`);
 if(pending.length&&!process.env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY is required for uncached embeddings.');
 let inputTokens=0,calls=0;
 for(let start=0;start<pending.length;start+=64){
  const batch=pending.slice(start,start+64);
  const response=await fetch('https://api.openai.com/v1/embeddings',{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(30_000),body:JSON.stringify({model:MODEL,dimensions:DIMENSIONS,input:batch.map(row=>row.text),encoding_format:'float'})});
  if(!response.ok)throw new Error(`Embedding provider returned ${response.status}. No response body logged.`);
  const data=await response.json() as {data:{index:number;embedding:number[]}[];usage?:{total_tokens:number}};
  if(data.data.length!==batch.length||new Set(data.data.map(row=>row.index)).size!==batch.length)throw new Error('Incomplete embedding batch.');
  const generatedAt=new Date().toISOString();cache.generatedAt??={};
  for(const row of data.data){if(!batch[row.index]||row.embedding.length!==DIMENSIONS||row.embedding.some(x=>!Number.isFinite(x)))throw new Error('Invalid embedding vector.');cache.vectors[batch[row.index].hash]=row.embedding;cache.generatedAt[batch[row.index].hash]=generatedAt;}
  inputTokens+=data.usage?.total_tokens??0;calls++;await atomic(cachePath,cache);
 }
 const imported=await promisify(execFile)('python3',[resolve('scripts/import-knowledge-embeddings.py'),'--index',resolve('research/knowledge/serving-index.json'),'--cache',cachePath,'--db',resolve('work/knowledge/corpus.sqlite')],{maxBuffer:1024*1024});
 const sqlite=JSON.parse(imported.stdout) as {inserted:number;reused:number;activeObservationEmbeddings:number};
 const neighbors=nearestNeighbors(rows.map(row=>({id:row.id,vector:cache.vectors[row.hash]})));
 const artifact:SemanticNeighbors={version:1,corpusVersion:index.corpusVersion,model:MODEL,dimensions:DIMENSIONS,neighbors};
 await atomic(resolve('research/knowledge/semantic-neighbors.json'),artifact);
 await atomic(resolve('work/knowledge/embedding-run.json'),{at:new Date().toISOString(),corpusVersion:index.corpusVersion,observations:rows.length,embedded:pending.length,calls,inputTokens,sqlite});
 console.log(JSON.stringify({observations:rows.length,embedded:pending.length,calls,inputTokens,semanticEdges:Object.values(neighbors).reduce((n,edges)=>n+edges.length,0),sqlite}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error instanceof Error?error.message:'Embedding failed.');process.exitCode=1;});
