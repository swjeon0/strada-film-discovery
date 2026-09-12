import raw from './curated-catalog.json';
import {weights,type Film,type Source,type Batch,type Recommendation,type Connection} from './domain';
export const collection:Film[]=raw.films.map(f=>({id:f.key,title:f.title,year:f.year,director:f.director,country:f.country,runtime:'runtime' in f?f.runtime:undefined,aliases:f.aliasesKo,sourceIds:f.sourceIds,poster:`/posters/${f.key}.jpg`}));
export const sourceLibrary=raw.sources as Source[];
export const filmById=(id:string)=>collection.find(f=>f.id===id);
const normalize=(x:string)=>x.toLocaleLowerCase().normalize('NFKD').replace(/[\p{P}\p{M}\s]/gu,'');
export function searchCollection(query:string,limit=6){const q=normalize(query);return collection.filter(f=>!q||normalize([f.title,f.director,f.year,...f.aliases??[]].join(' ')).includes(q)).slice(0,limit);}
export function recommendCollection(seeds:Film[],trail:Film[]):Batch{
 const context=weights(seeds,trail);const excluded=new Set(context.map(x=>x.film.id));const scores=new Map<string,{score:number,connections:Connection[]}>();
 for(const {film,weight} of context){for(const e of raw.edges){const id=e.from===film.id?e.to:e.to===film.id?e.from:null;if(!id||excluded.has(id))continue;const row=scores.get(id)??{score:0,connections:[]};const quality=e.relation==='direct_connection'?1:e.relation==='grounded_interpretation'?.78:.6;row.score+=weight*quality;row.connections.push({anchorId:film.id,anchorTitle:film.title,relation:e.relation as Connection['relation'],why:e.why,sourceIds:e.sourceIds});scores.set(id,row);}}
 const weightById=new Map(context.map(x=>[x.film.id,x.weight]));
 const recs:Recommendation[]=[...scores.entries()].sort((a,b)=>b[1].score-a[1].score||a[0].localeCompare(b[0])).slice(0,12).map(([id,row])=>{const film=filmById(id)!;row.connections.sort((a,b)=>(weightById.get(b.anchorId)??0)-(weightById.get(a.anchorId)??0));const evidence=[...new Set(row.connections.flatMap(c=>c.sourceIds))];const extras=(film.sourceIds??[]).filter(id=>!evidence.includes(id)).slice(0,Math.max(0,3-evidence.length));return {film,connections:row.connections,sourceIds:[...evidence,...extras]};});
 const used=new Set(recs.flatMap(r=>r.sourceIds));return {mode:'collection',recommendations:recs,sources:sourceLibrary.filter(s=>used.has(s.id))};
}
