import { z } from "zod";
import {cleanDisplayProse} from "./prose";
export type Language='en'|'ko';
export const ResearchIntentSchema=z.enum(['initial','follow','manual','regenerate']);
export type ResearchIntent=z.infer<typeof ResearchIntentSchema>;
export type ResearchOptions={intent:ResearchIntent;previousIds:string[];language:Language};
export const MAX_SESSION_SNAPSHOTS=64;
export const MAX_SEEN_FILMS=5000;
// localStorage commonly accounts for UTF-16; leave room for other application data.
export const MAX_SESSION_STORAGE_CHARS=1_500_000;
export const FilmIdSchema=z.string().min(1).max(100);
export const FilmSchema=z.object({id:z.string().min(1).max(100),title:z.string().min(1).max(240),year:z.number().int().min(1850).max(2200),director:z.string().max(240),poster:z.string().max(1000),titleKo:z.string().optional(),titleKoSource:z.string().optional(),wikidataId:z.string().optional(),originalTitle:z.string().optional(),overviewEn:z.string().optional(),overviewKo:z.string().optional(),overviewEnSource:z.string().optional(),overviewKoSource:z.string().optional(),synopsisEn:z.string().optional(),synopsisKo:z.string().optional(),synopsisEnSource:z.string().optional(),synopsisKoSource:z.string().optional(),wikiEn:z.string().optional(),wikiKo:z.string().optional(),genres:z.array(z.string()).optional(),country:z.string().optional(),runtime:z.number().optional(),aliases:z.array(z.string()).optional(),sourceIds:z.array(z.string()).optional()});
export type Film=z.infer<typeof FilmSchema>;
export const SourceSchema=z.object({id:z.string(),title:z.string(),publisher:z.string(),author:z.string().nullable(),date:z.string().nullable(),url:z.string().url().refine(u=>u.startsWith('https://')),type:z.enum(['academic','criticism','festival','catalogue']),scope:z.string(),summary:z.string().transform(cleanDisplayProse),summaryKo:z.string().transform(cleanDisplayProse).optional(),excerpt:z.string().max(2000).optional(),accessLevel:z.string(),verifiedOn:z.string().optional()});
export type Source=z.infer<typeof SourceSchema>;
export const ConnectionSchema=z.object({anchorId:z.string(),anchorTitle:z.string(),relation:z.enum(['direct_connection','curatorial_association','grounded_interpretation','ai_inference']),why:z.string().transform(cleanDisplayProse),whyKo:z.string().transform(cleanDisplayProse).optional(),sourceIds:z.array(z.string())});
export type Connection=z.infer<typeof ConnectionSchema>;
export const RecommendationSchema=z.object({film:FilmSchema,connections:z.array(ConnectionSchema).min(1),sourceIds:z.array(z.string()),contextScope:z.literal('discovery').optional(),curation:z.object({lens:z.string().max(1000).transform(cleanDisplayProse),bridge:z.string().max(2000).transform(cleanDisplayProse),contrast:z.string().max(2000).transform(cleanDisplayProse)}).optional(),detailToken:z.string().max(16000).optional()}).refine(r=>r.connections.every(c=>c.relation==='ai_inference'?c.sourceIds.length===0:c.sourceIds.length>0)&&r.connections.every(c=>c.sourceIds.every(id=>r.sourceIds.includes(id)))&&(!r.connections.every(c=>c.relation==='ai_inference')||r.sourceIds.length===0),'Evidence is required for sourced recommendations; AI interpretations must not invent citations.');
export type Recommendation=z.infer<typeof RecommendationSchema>;
export const SnapshotSchema=z.object({id:z.string(),createdAt:z.string(),seeds:z.array(FilmSchema).min(1).max(8),trail:z.array(FilmSchema).max(30),recommendations:z.array(RecommendationSchema).min(1).max(12),sources:z.array(SourceSchema).max(48),language:z.enum(['en','ko']).optional(),action:ResearchIntentSchema.optional(),notice:z.literal('partial').optional(),mode:z.enum(['collection','live'])});
export type Snapshot=z.infer<typeof SnapshotSchema>;
export const SessionSchema=z.object({version:z.literal(2),seedDraft:z.array(FilmSchema).max(8),snapshots:z.array(SnapshotSchema).max(MAX_SESSION_SNAPSHOTS),archivedSeenIds:z.array(FilmIdSchema).max(MAX_SEEN_FILMS).optional(),cursor:z.number().int().min(-1)}).refine(s=>s.cursor<s.snapshots.length && (s.snapshots.length===0?s.cursor===-1:s.cursor>=0));
export type Session=z.infer<typeof SessionSchema>;
export const EMPTY_SESSION:Session={version:2,seedDraft:[],snapshots:[],cursor:-1};
export const STORAGE_KEY='strada.session.v2';
export const LEGACY_STORAGE_KEY='closeup.session.v2';
export const titleOf=(film:Film,language:Language)=>language==='ko'&&film.titleKo?film.titleKo:film.title;
export type Batch={recommendations:Recommendation[];sources:Source[];mode:'collection'|'live';notice?:'partial'};
export function weights(seeds:Film[],trail:Film[]){
 const films=[...new Map([...seeds,...trail].map(film=>[film.id,film])).values()];return films.map(film=>({film,weight:1/films.length}));
}
export function commitSnapshot(s:Session,snapshot:Snapshot,newTrail:boolean):Session{
 if(!snapshot.recommendations.length)throw new Error('Cannot commit an empty recommendation batch.');
 const snapshots=newTrail?[snapshot]:[...s.snapshots.slice(0,s.cursor+1),snapshot];
 const archived=new Set(newTrail?[]:s.archivedSeenIds??[]);
 const seen=new Set([...archived,...snapshots.flatMap(sn=>sn.recommendations.map(rec=>rec.film.id))]);
 if(seen.size>MAX_SEEN_FILMS)throw new Error('This path has reached its discovery history limit. Start a new path to continue.');
 const result:Session={...s,seedDraft:snapshot.seeds,snapshots,cursor:snapshots.length-1};
 const syncArchive=()=>{result.cursor=result.snapshots.length-1;if(archived.size)result.archivedSeenIds=[...archived];else delete result.archivedSeenIds;};
 syncArchive();
 while(result.snapshots.length>1&&(result.snapshots.length>MAX_SESSION_SNAPSHOTS||JSON.stringify(result).length>MAX_SESSION_STORAGE_CHARS)){
  const removed=result.snapshots.shift()!;
  for(const rec of removed.recommendations)archived.add(rec.film.id);
  syncArchive();
 }
 return result;
}
export function restoreSnapshot(s:Session,cursor:number):Session{
 if(!Number.isInteger(cursor)||cursor<0||cursor>=s.snapshots.length)throw new Error('Unknown trail step.');return {...s,cursor};
}
export function parseSession(raw:string):Session{
 const s=SessionSchema.parse(JSON.parse(raw));
 const allSeen=new Set([...(s.archivedSeenIds??[]),...s.snapshots.flatMap(sn=>sn.recommendations.map(rec=>rec.film.id))]);
 if(allSeen.size>MAX_SEEN_FILMS)throw new Error('This discovery history exceeds the supported path length.');
 for(const sn of s.snapshots){const ids=new Set([...sn.seeds,...sn.trail].map(f=>f.id));if(ids.size!==sn.seeds.length+sn.trail.length)throw new Error('Duplicate film in trail.');const sourceIds=new Set(sn.sources.map(x=>x.id));if(sn.recommendations.some(r=>ids.has(r.film.id)||r.sourceIds.some(id=>!sourceIds.has(id))||r.connections.some(c=>!ids.has(c.anchorId)||c.sourceIds.some(id=>!sourceIds.has(id)))))throw new Error('Invalid saved evidence.');}
 return s;
}
export function safePoster(p:string){if(p.startsWith('/posters/')&&!p.includes('..'))return p;try{const u=new URL(p);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['image.tmdb.org','upload.wikimedia.org','thumb.wikimedia.org'].includes(u.hostname)?p:'';}catch{return '';}}
