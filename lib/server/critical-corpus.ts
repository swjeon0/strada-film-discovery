import {z} from 'zod';
import records from './critical-corpus.json';
import type {Film} from '../domain';
import type {CuratorialQuery} from './source-search';
import {filmMentioned,normalizedText} from './grounding';

export const CRITICAL_CORPUS_VERSION='pilot-reviewed-v1';
export const CorpusSignalSchema=z.object({
 id:z.string().max(20),sourceType:z.enum(['programme','criticism','scholarship']),sourceTitle:z.string().max(300),url:z.string().url(),
 entities:z.array(z.string()).max(16),operation:z.string().max(80),claim:z.string().max(800),boundary:z.string().max(600),hook:z.string().max(600),matchedFilmIds:z.array(z.string()).max(38),
});
export type CorpusSignal=z.infer<typeof CorpusSignalSchema>;
const CorpusRecordSchema=CorpusSignalSchema.omit({matchedFilmIds:true});
const corpus=z.array(CorpusRecordSchema).parse(records);

function terms(value:string){return [...new Set((value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(term=>term.length>=3))];}
function match(record:z.infer<typeof CorpusRecordSchema>,film:Film){
 const text=[record.sourceTitle,...record.entities,record.claim].join(' '),direct=filmMentioned(text,film);
 const titleTerms=terms([film.title,film.titleKo,film.originalTitle].filter(Boolean).join(' ')),overlap=titleTerms.filter(term=>normalizedText(text).includes(normalizedText(term))).length;
 const director=film.director&&normalizedText(text).includes(normalizedText(film.director));
 return {direct,score:(direct?16:0)+Math.min(6,overlap*2)+(director?2:0)};
}

/** Reviewed claims are retrieval hypotheses with explicit boundaries, never quote evidence. */
export function retrieveCorpusSignals(films:Film[],limit=8):CorpusSignal[]{
 const ranked=corpus.map(record=>{const matches=films.map(film=>({film,...match(record,film)})).filter(row=>row.score>0),matchedFilmIds=matches.filter(row=>row.direct||row.score>=4).map(row=>row.film.id);return {record,matchedFilmIds,score:matches.reduce((sum,row)=>sum+row.score,0)+Math.max(0,matchedFilmIds.length-1)*5};}).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.record.id.localeCompare(b.record.id));
 const chosen:CorpusSignal[]=[],operationUse=new Map<string,number>(),entityUse=new Map<string,number>();
 while(ranked.length&&chosen.length<limit){
  ranked.sort((a,b)=>{const novelty=(row:typeof a)=>row.score-(operationUse.get(row.record.operation)??0)*2-Math.max(0,...row.record.entities.map(entity=>entityUse.get(normalizedText(entity))??0))*1.5;return novelty(b)-novelty(a)||a.record.id.localeCompare(b.record.id);});
  const next=ranked.shift()!;chosen.push({...next.record,matchedFilmIds:next.matchedFilmIds});operationUse.set(next.record.operation,(operationUse.get(next.record.operation)??0)+1);for(const entity of next.record.entities)entityUse.set(normalizedText(entity),(entityUse.get(normalizedText(entity))??0)+1);
 }
 return chosen;
}

export function corpusOperationQuery(signals:CorpusSignal[],films:Film[]):CuratorialQuery|null{
 if(!signals.length)return null;
 const selected=signals.slice(0,3),question=['Film criticism or scholarship on the following precise operations and productive contrasts:',...selected.map(signal=>`${signal.hook} Boundary: ${signal.boundary}`)].join(' ').slice(0,500);
 return {query:question,filmIds:[...new Set(films.map(film=>film.id))],purpose:'lens'};
}
