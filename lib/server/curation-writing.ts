import {z} from 'zod';
import {CuratedFilm,EvidenceNote,type Candidate} from '../curation-contract';
import {CURATOR_WRITE_PROMPT} from '../curation-writing-prompt';
import {cleanDisplayProse} from '../prose';
import {type Film,type Language,titleOf} from '../domain';
import {curatorResponse} from './curator-model';
import {curationSettings} from './curation-settings';
import {emptyUsage,sumUsage,type ResearchUsage,type Reference} from './source-search';
import {normalizedText} from './grounding';

type Plan=z.infer<typeof CuratedFilm>;
const Written=z.object({candidate:z.string(),why:z.string().min(20).max(4200).transform(text=>cleanDisplayProse(text).slice(0,1400))});
const Output=z.object({recommendations:z.array(Written).max(4)});
const schema=(codes:string[])=>({
 type:'object',additionalProperties:false,required:['recommendations'],
 properties:{recommendations:{type:'array',minItems:codes.length,maxItems:codes.length,items:{
  type:'object',additionalProperties:false,required:['candidate','why'],
  properties:{candidate:{type:'string',enum:codes},why:{type:'string'}},
 }}},
});
export async function writeCuratedExplanations(plans:Map<string,Plan>,verified:{code:string;film:Film;draft:Candidate}[],selected:Film[],references:Map<string,Reference>,language:Language,signal:AbortSignal){
 signal.throwIfAborted();
 const started=Date.now(),byCode=new Map(verified.map(item=>[item.code,item])),rows=[...plans.values()].filter(plan=>byCode.has(plan.candidate)).slice(0,12),groups:Plan[][]=[];
 for(let i=0;i<rows.length;i+=4)groups.push(rows.slice(i,i+4));
 const selectedInput=[...selected].sort((a,b)=>a.id.localeCompare(b.id)).map((f,i)=>({code:`a${i}`,id:f.id,title:f.title,displayTitle:titleOf(f,language),year:f.year,director:f.director}));
 let usage:ResearchUsage=emptyUsage(curationSettings().stages.write.model),fallback=false;
 const expanded=new Map(plans);
 await Promise.all(groups.map(async group=>{
  try{
   const result=await curatorResponse('write',schema(group.map(plan=>plan.candidate)),CURATOR_WRITE_PROMPT,{
    language,selected:selectedInput,
    approvedConnections:group.map(plan=>{const entry=byCode.get(plan.candidate)!;return {candidate:plan.candidate,film:{title:entry.film.title,displayTitle:titleOf(entry.film,language),year:entry.film.year,director:entry.film.director},anchors:plan.anchors,decision:plan.why,evidence:plan.evidence.flatMap(value=>{
     const parsed=EvidenceNote.safeParse(value);if(!parsed.success)return [];
     const note=parsed.data,source=references.get(note.ref),passage=normalizedText(note.passage);
     // A plausible quotation with a real source ID is still not evidence until
     // it matches text we actually read. Validate before the writer can use it.
     return source&&note.point&&passage.length>=25&&normalizedText(source.text).includes(passage)?[{title:source.source.title,passage:note.passage,limitedSupport:note.point}]:[];
    })};}),
   },signal,2400,18000);
   usage=sumUsage(usage,result.usage);
   const output=Output.safeParse(result.output);if(!output.success)throw new Error('Invalid explanation response');
   const expected=new Set(group.map(plan=>plan.candidate)),seen=new Set<string>();
   for(const row of output.data.recommendations){if(!expected.has(row.candidate)||seen.has(row.candidate))continue;seen.add(row.candidate);expanded.set(row.candidate,{...plans.get(row.candidate)!,why:row.why});}
   if(seen.size!==expected.size)fallback=true;
  }catch(error){if(signal.aborted)throw signal.reason;fallback=true;console.warn('STRADA explanation writing fallback',{error:error instanceof Error?error.name:'unknown'});}
 }));
 return {curated:expanded,usage,writingMs:Date.now()-started,fallback};
}
