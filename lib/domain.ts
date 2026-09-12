import { z } from "zod";
export const FilmSchema=z.object({id:z.string().min(1).max(100),title:z.string().min(1).max(240),year:z.number().int().min(1850).max(2200),director:z.string().max(240),poster:z.string().max(1000),country:z.string().optional(),runtime:z.number().optional(),aliases:z.array(z.string()).optional(),sourceIds:z.array(z.string()).optional()});
export type Film=z.infer<typeof FilmSchema>;
export const SourceSchema=z.object({id:z.string(),title:z.string(),publisher:z.string(),author:z.string().nullable(),date:z.string().nullable(),url:z.string().url().refine(u=>u.startsWith('https://')),type:z.enum(['academic','criticism','festival','catalogue']),scope:z.string(),summary:z.string(),accessLevel:z.string(),verifiedOn:z.string().optional()});
export type Source=z.infer<typeof SourceSchema>;
export const ConnectionSchema=z.object({anchorId:z.string(),anchorTitle:z.string(),relation:z.enum(['direct_connection','curatorial_association','grounded_interpretation']),why:z.string(),sourceIds:z.array(z.string()).min(1)});
export type Connection=z.infer<typeof ConnectionSchema>;
export const RecommendationSchema=z.object({film:FilmSchema,connections:z.array(ConnectionSchema).min(1),sourceIds:z.array(z.string()).min(1)});
export type Recommendation=z.infer<typeof RecommendationSchema>;
export const SnapshotSchema=z.object({id:z.string(),createdAt:z.string(),seeds:z.array(FilmSchema).min(1).max(8),trail:z.array(FilmSchema).max(30),recommendations:z.array(RecommendationSchema).min(1).max(12),sources:z.array(SourceSchema).max(48),mode:z.enum(['collection','live'])});
export type Snapshot=z.infer<typeof SnapshotSchema>;
export const SessionSchema=z.object({version:z.literal(2),seedDraft:z.array(FilmSchema).max(8),snapshots:z.array(SnapshotSchema).max(31),cursor:z.number().int().min(-1)}).refine(s=>s.cursor<s.snapshots.length && (s.snapshots.length===0?s.cursor===-1:s.cursor>=0));
export type Session=z.infer<typeof SessionSchema>;
export const EMPTY_SESSION:Session={version:2,seedDraft:[],snapshots:[],cursor:-1};
export const STORAGE_KEY='closeup.session.v2';
export type Batch={recommendations:Recommendation[];sources:Source[];mode:'collection'|'live'};
export function weights(seeds:Film[],trail:Film[]){
 const t=trail.length;const raw=[...seeds.map(f=>({film:f,weight:Math.pow(.7,t)/seeds.length})),...trail.map((f,i)=>({film:f,weight:Math.pow(.7,t-i-1)}))];const sum=raw.reduce((s,x)=>s+x.weight,0);return raw.map(x=>({...x,weight:x.weight/sum}));
}
export function commitSnapshot(s:Session,snapshot:Snapshot,newTrail:boolean):Session{
 if(!snapshot.recommendations.length)throw new Error('Cannot commit an empty recommendation batch.');
 const snapshots=newTrail?[snapshot]:[...s.snapshots.slice(0,s.cursor+1),snapshot];
 return {...s,seedDraft:snapshot.seeds,snapshots,cursor:snapshots.length-1};
}
export function restoreSnapshot(s:Session,cursor:number):Session{
 if(!Number.isInteger(cursor)||cursor<0||cursor>=s.snapshots.length)throw new Error('Unknown trail step.');return {...s,cursor};
}
export function parseSession(raw:string):Session{
 const s=SessionSchema.parse(JSON.parse(raw));
 for(const sn of s.snapshots){const ids=new Set([...sn.seeds,...sn.trail].map(f=>f.id));if(ids.size!==sn.seeds.length+sn.trail.length)throw new Error('Duplicate film in trail.');const sourceIds=new Set(sn.sources.map(x=>x.id));if(sn.recommendations.some(r=>ids.has(r.film.id)||r.sourceIds.some(id=>!sourceIds.has(id))||r.connections.some(c=>!ids.has(c.anchorId)||c.sourceIds.some(id=>!sourceIds.has(id)))))throw new Error('Invalid saved evidence.');}
 return s;
}
export function safePoster(p:string){return p.startsWith('/posters/')&&!p.includes('..')||/^https:\/\/image\.tmdb\.org\/t\/p\//.test(p)?p:'';}
