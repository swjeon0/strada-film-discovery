import {createHmac,timingSafeEqual} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {FilmSchema,SourceSchema,type Film} from '../domain';
import {CuratorialCandidate,CuratedFilm,LensSchema,QuerySchema} from '../curation-contract';
import {config} from './config';

export const PREPARATION_TOKEN_LIMIT=220000;
export const PREPARATION_TTL=6*60*60*1000;
const PREPARATION_JSON_LIMIT=1_000_000;
export const CriticalDecisionSchema=z.object({fingerprint:z.string(),contextFingerprint:z.string(),ranking:z.array(z.string()).max(32),recommendations:z.array(CuratedFilm).max(12),rejected:z.array(z.string()).max(32)});
const ReferenceSchema=z.object({source:SourceSchema,text:z.string().max(10000),anchorIds:z.array(z.string()).max(80),purpose:z.enum(['anchor','lens','candidate']).optional(),query:z.string().max(600).optional()});
export const PreparationSchema=z.object({version:z.literal(1),issued:z.number(),fingerprint:z.string(),language:z.enum(['en','ko']),decision:CriticalDecisionSchema.optional(),selected:z.array(FilmSchema).min(1).max(38),lenses:z.array(LensSchema).min(1).max(3),queries:z.array(QuerySchema).max(6),candidates:z.array(z.object({code:z.string(),draft:CuratorialCandidate,film:FilmSchema})).min(0).max(32),references:z.array(ReferenceSchema).max(12),coveredFilmIds:z.array(z.string()).max(38)});
export type Preparation=z.infer<typeof PreparationSchema>;
function signature(body:string){return createHmac('sha256',config().openai||'').update('strada-preparation-v1:'+body).digest('base64url');}
export function issuePreparationToken(preparation:Preparation){
 if(!config().openai)return undefined;
 const json=JSON.stringify(PreparationSchema.parse(preparation));
 // Issued tokens must obey the same decompressed bound as the reader, even for
 // highly compressible synopsis text that fits the transmitted token limit.
 if(Buffer.byteLength(json,'utf8')>PREPARATION_JSON_LIMIT)return undefined;
 const body=gzipSync(json).toString('base64url');
 const token=body+'.'+signature(body);return token.length<=PREPARATION_TOKEN_LIMIT?token:undefined;
}
export function readPreparationToken(token:string|undefined,films:Film[],language:string,fingerprint:string,allowSelectedSubset=false):Preparation|null{
 if(!token||token.length>PREPARATION_TOKEN_LIMIT||!config().openai)return null;
 try{
  const parts=token.split('.');if(parts.length!==2)return null;
  const [body,signed]=parts,actual=Buffer.from(signed),expected=Buffer.from(signature(body));
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
  const parsed=PreparationSchema.parse(JSON.parse(gunzipSync(Buffer.from(body,'base64url'),{maxOutputLength:PREPARATION_JSON_LIMIT}).toString('utf8')));
  if(parsed.issued>Date.now()+60000||Date.now()-parsed.issued>PREPARATION_TTL||parsed.language!==language||parsed.fingerprint!==fingerprint)return null;
  const ids=(values:Film[])=>values.map(f=>f.id).sort().join('|');
  if(allowSelectedSubset){const current=new Set(films.map(f=>f.id));if(parsed.selected.some(f=>!current.has(f.id)))return null;}else if(ids(parsed.selected)!==ids(films))return null;
  return parsed;
 }catch{return null;}
}
