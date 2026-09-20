import {createHash} from 'node:crypto';
import rawSnapshot from '../../../research/curator/context-snapshot.json';
import type {Film,Language} from '../../domain';
import {ContextBundleSchema,type ContextBundle,type ContextPassage} from '../curator-v1/contract';
import type {KnowledgeRepository} from './repository';

type Snapshot={version:1;corpusVersion:string;builtAt:string;passages:ContextPassage[]};
const snapshot=rawSnapshot as Snapshot;
const normalize=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');

export class SnapshotKnowledgeRepository implements KnowledgeRepository{
 private readonly data:Snapshot;
 constructor(data:unknown=snapshot){this.data=ContextBundleSchema.pick({version:true,corpusVersion:true,builtAt:true,passages:true}).parse(data) as Snapshot;}
 fingerprint(){return createHash('sha256').update(JSON.stringify(this.data)).digest('hex').slice(0,16);}
 async buildContext(selected:Film[],language:Language):Promise<ContextBundle>{
  void language;
  const ids=new Set(selected.flatMap(film=>[film.id,film.wikidataId?`wd:${film.wikidataId}`:'']).filter(Boolean));
  const titleTerms=new Set(selected.flatMap(film=>[film.title,film.originalTitle??'',film.titleKo??'',...film.aliases??[]]).filter(Boolean).map(normalize));
  const directorTerms=new Set(selected.map(film=>film.director).filter(Boolean).map(normalize));
  const scored=this.data.passages.map(passage=>{
   const direct=passage.filmIds.some(id=>ids.has(id))?8:0;
   const haystack=normalize([passage.title,passage.excerpt,...passage.subjects].join(' '));
   const titles=[...titleTerms].reduce((score,term)=>score+(term&&haystack.includes(term)?4:0),0);
   const directors=[...directorTerms].reduce((score,term)=>score+(term&&haystack.includes(term)?2:0),0);
   return {passage,score:direct+titles+directors};
  }).filter(row=>row.score>0);
  const ranked=scored.sort((a,b)=>b.score-a.score||a.passage.id.localeCompare(b.passage.id)),chosen=new Map<string,ContextPassage>();
  // Give every covered input a reading before filling by relevance. Unmatched
  // documents are omitted: an empty dossier is better than unrelated context.
  for(const id of [...ids].sort())for(const row of ranked.filter(item=>item.passage.filmIds.includes(id)).slice(0,2))chosen.set(row.passage.id,row.passage);
  for(const row of ranked){if(chosen.size>=16)break;chosen.set(row.passage.id,row.passage);}
  const passages=[...chosen.values()];
  return ContextBundleSchema.parse({version:1,corpusVersion:this.data.corpusVersion,builtAt:this.data.builtAt,
   selectedFilmIds:[...selected.map(film=>film.id)].sort(),passages,legacyNotes:[]});
 }
}
