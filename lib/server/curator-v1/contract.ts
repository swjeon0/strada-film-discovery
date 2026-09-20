import {z} from 'zod';
import type {Film,Language} from '../../domain';

export const EvidenceAttributionSchema=z.enum(['source_explicit','source_supported_interpretation','model_proposal']);
export type EvidenceAttribution=z.infer<typeof EvidenceAttributionSchema>;

export const ContextPassageSchema=z.object({
 id:z.string().min(1).max(180),documentId:z.string().min(1).max(120),title:z.string().min(1).max(300),
 author:z.string().max(200).nullable(),publisher:z.string().min(1).max(200),url:z.string().url(),
 type:z.enum(['academic','criticism','festival','programme']),locator:z.string().min(1).max(500),
 excerpt:z.string().min(12).max(900),filmIds:z.array(z.string()).max(80),subjects:z.array(z.string().min(1).max(100)).max(20),
 contentKind:z.enum(['exact_passage','reviewed_paraphrase']).default('exact_passage'),
 reviewState:z.enum(['human_checked','agent_reviewed']),rights:z.enum(['quotation_for_research','link_and_metadata_only','open_license','noncommercial']),
 observation:z.string().max(1200).optional(),observationEn:z.string().max(1200).optional(),observationKo:z.string().max(1200).optional(),boundary:z.string().max(900).optional(),
 connectionKind:z.enum(['film_reading','comparison','contrast','influence','co_programming','historical_context','incidental_mention']).optional(),
 accessLevel:z.enum(['full_page','abstract','metadata_only']).optional(),versionId:z.string().optional(),checkedAt:z.string().optional(),sourceLanguage:z.string().optional(),publishedAt:z.string().nullable().optional(),
 retrievalRole:z.enum(['selected_reading','related_context']).optional(),retrievedFor:z.array(z.string()).optional(),
 relatedFilms:z.array(z.object({id:z.string(),title:z.string(),year:z.number(),director:z.string(),aliases:z.array(z.string())})).optional(),
});
export type ContextPassage=z.infer<typeof ContextPassageSchema>;

export const LegacyNoteSchema=z.object({id:z.string(),text:z.string(),warning:z.literal('not_quote_evidence')});
export const ContextBundleSchema=z.object({
 version:z.literal(1),corpusVersion:z.string(),builtAt:z.string().datetime(),selectedFilmIds:z.array(z.string()).min(1).max(38),
 passages:z.array(ContextPassageSchema).max(24),legacyNotes:z.array(LegacyNoteSchema).max(12),
});
export type ContextBundle=z.infer<typeof ContextBundleSchema>;

export const CuratorProposalSchema=z.object({
 title:z.string().min(1).max(240),year:z.number().int().min(1888).max(2100),director:z.string().min(1).max(240),
 anchorIds:z.array(z.string()).min(1).max(38),connection:z.string().min(4).max(120),
 evidenceIds:z.array(z.string()).max(2),attribution:EvidenceAttributionSchema,
});
export type CuratorProposal=z.infer<typeof CuratorProposalSchema>;

export const CuratorOutputSchema=z.object({
 lens:z.string().min(4).max(160),description:z.string().min(4).max(160),
 recommendations:z.array(CuratorProposalSchema).length(12),
});
export type CuratorOutput=z.infer<typeof CuratorOutputSchema>;

const WireProposalSchema=z.object({t:z.string().min(1).max(240),y:z.number().int().min(1888).max(2100),d:z.string().min(1).max(240),
 a:z.array(z.number().int().min(0).max(37)).min(1).max(38),b:z.string().min(4).max(120),e:z.array(z.number().int().min(0).max(23)).max(2),k:z.enum(['x','s','m'])});
const RepairWireProposalSchema=WireProposalSchema.pick({t:true,y:true,d:true,a:true,b:true});
export const CuratorWireSchema=z.object({v:z.string().min(4).max(160),r:z.array(WireProposalSchema).length(12)}).strict();
export const CURATOR_V1_OUTPUT_JSON_SCHEMA={type:'object',additionalProperties:false,required:['v','r'],properties:{
 v:{type:'string',minLength:4,maxLength:160},
 r:{type:'array',minItems:12,maxItems:12,items:wireProposalJsonSchema()},
}} as const;

function wireProposalJsonSchema(){return {type:'object',additionalProperties:false,required:['t','y','d','a','b','e','k'],properties:{
 t:{type:'string',minLength:1,maxLength:240},y:{type:'integer',minimum:1888,maximum:2100},d:{type:'string',minLength:1,maxLength:240},
 a:{type:'array',minItems:1,maxItems:38,items:{type:'integer',minimum:0,maximum:37}},b:{type:'string',minLength:4,maxLength:120},e:{type:'array',maxItems:2,items:{type:'integer',minimum:0,maximum:23}},k:{type:'string',enum:['x','s','m']},
}} as const;}
function repairWireProposalJsonSchema(){return {type:'object',additionalProperties:false,required:['t','y','d','a','b'],properties:{
 t:{type:'string',minLength:1,maxLength:240},y:{type:'integer',minimum:1888,maximum:2100},d:{type:'string',minLength:1,maxLength:240},
 a:{type:'array',minItems:1,maxItems:38,items:{type:'integer',minimum:0,maximum:37}},b:{type:'string',minLength:4,maxLength:120},
}} as const;}

export function curatorRepairJsonSchema(count:number){return {type:'object',additionalProperties:false,required:['r'],properties:{r:{type:'array',minItems:count,maxItems:count,items:repairWireProposalJsonSchema()}}} as const;}

export function applyCuratorRepairs(raw:unknown,request:CuratorV1Request,original:CuratorOutput,indexes:number[]){
 const parsed=z.object({r:z.array(RepairWireProposalSchema).length(indexes.length)}).strict().parse(raw),recommendations=[...original.recommendations];
 for(const [offset,index] of indexes.entries()){
  const replacement=parsed.r[offset],anchorIds=[...new Set(replacement.a.flatMap(anchorIndex=>request.selected[anchorIndex]?[request.selected[anchorIndex].id]:[]))];
  recommendations[index]={title:replacement.t,year:replacement.y,director:replacement.d,anchorIds,connection:replacement.b,evidenceIds:[],attribution:'model_proposal'};
 }
 return validateCuratorOutput({...original,recommendations},request);
}

export type CuratorV1Request={selected:Film[];excludedIds:string[];forbiddenFilms?:Pick<Film,'id'|'title'|'year'|'director'>[];language:Language;context:ContextBundle};
export type ResolvedCuratorRecommendation={film:Film;anchorIds:string[];connection:string;evidenceIds:string[];attribution:EvidenceAttribution};
export type CuratorDecision={lens:string;description:string;recommendations:ResolvedCuratorRecommendation[]};

const normalize=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');

export function decodeCuratorWire(raw:unknown,request:CuratorV1Request):CuratorOutput{
 const wire=CuratorWireSchema.parse(raw),allAnchorIds=request.selected.map(film=>film.id),attribution={x:'source_explicit',s:'source_supported_interpretation',m:'model_proposal'} as const;
 const decode=(proposal:z.infer<typeof WireProposalSchema>):CuratorProposal=>{
  let evidenceIds=proposal.e.flatMap(index=>{const passage=request.context.passages[index];return passage?[passage.id]:[];}),kind:EvidenceAttribution=attribution[proposal.k];
  // Provenance has deterministic precedence over a contradictory model label.
  // A model proposal cannot borrow citations; a sourced label without a source becomes a model proposal.
  if(kind==='model_proposal')evidenceIds=[];else if(!evidenceIds.length)kind='model_proposal';
  const anchorIds=[...new Set(proposal.a.flatMap(index=>allAnchorIds[index]?[allAnchorIds[index]]:[]))];
  return {title:proposal.t,year:proposal.y,director:proposal.d,connection:proposal.b,anchorIds,evidenceIds,attribution:kind};
 };
 const recommendations=wire.r.map(decode),requestedLens=request.language==='ko'&&!/[가-힣]/u.test(wire.v)
  ?`${recommendations.slice(0,3).map(item=>item.connection).join(' · ')}의 경로`.slice(0,160)
  :wire.v;
 return {lens:requestedLens,description:requestedLens,recommendations};
}

export function validateCuratorOutput(raw:unknown,request:CuratorV1Request){
 const output=CuratorOutputSchema.parse(raw),anchors=new Set(request.selected.map(film=>film.id));
 const evidence=new Set(request.context.passages.map(passage=>passage.id));
 const passages=new Map(request.context.passages.map(passage=>[passage.id,passage]));
 for(const proposal of output.recommendations){
  if(proposal.anchorIds.some(id=>!anchors.has(id)))throw new Error('CURATOR_UNKNOWN_ANCHOR');
  if(proposal.evidenceIds.some(id=>!evidence.has(id)))throw new Error('CURATOR_UNKNOWN_EVIDENCE');
  if(proposal.attribution==='model_proposal'&&proposal.evidenceIds.length)throw new Error('CURATOR_MODEL_PROPOSAL_HAS_EVIDENCE');
  if(proposal.attribution!=='model_proposal'&&!proposal.evidenceIds.length)throw new Error('CURATOR_SOURCED_PROPOSAL_LACKS_EVIDENCE');
  if(proposal.attribution==='source_explicit'){
   const title=normalize(proposal.title),direct=proposal.evidenceIds.some(id=>{
    const passage=passages.get(id);if(!passage)return false;
    if(passage.contentKind!=='exact_passage')return false;
    if(passage.observation){
     // Even a quotation naming both films cannot establish every claim in a
     // newly generated connection (e.g. comparison does not prove influence).
     // The author's actual observation is shown separately on the source card.
     return false;
    }
    const mentionsCandidate=normalize([passage.title,passage.excerpt,...passage.subjects].join(' ')).includes(title);
    return mentionsCandidate&&proposal.anchorIds.some(anchorId=>passage.filmIds.includes(anchorId));
   });
   // The model cannot upgrade a contextual passage to a direct documented comparison.
   if(!direct)proposal.attribution='source_supported_interpretation';
  }
 }
 const covered=new Set(output.recommendations.flatMap(proposal=>proposal.anchorIds));
 if([...anchors].some(id=>!covered.has(id)))throw new Error('CURATOR_INCOMPLETE_SET_READING');
 return output;
}
