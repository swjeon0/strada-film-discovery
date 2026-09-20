import {z} from 'zod';
import {CuratedFilm,EvidenceNote} from '../curation-contract';
import type {Film} from '../domain';
import {filmMentioned,normalizedText} from './grounding';
import type {Reference} from './source-search';

export type CuratedPlan=z.infer<typeof CuratedFilm>;
type CandidateRow={code:string;film:Film;draft:{lens:string}};

function exactPassage(reference:Reference,passage:string){
 const needle=normalizedText(passage);
 return needle.length>=25&&normalizedText(reference.text).includes(needle);
}

/** Keep only evidence whose copied passage exists and supports one side of this decision. */
export function sanitizePlanEvidence(plan:CuratedPlan,candidate:Film,references:Map<string,Reference>,anchors:Map<string,Film>):CuratedPlan{
 const evidence=plan.evidence.flatMap(value=>{
  const parsed=EvidenceNote.safeParse(value);if(!parsed.success)return [];
  const note=parsed.data,reference=references.get(note.ref);if(!reference||!exactPassage(reference,note.passage)||!note.point.trim())return [];
  const plannedIds=new Set(plan.anchors.map(code=>anchors.get(code)?.id).filter((id):id is string=>!!id));
  const supportsCandidate=filmMentioned(note.passage,candidate),supportsAnchor=reference.anchorIds.some(id=>plannedIds.has(id));
  // A lens essay may support a formal concept without naming either film. Other
  // sources must visibly discuss the candidate or one of the claimed anchors.
  return supportsCandidate||supportsAnchor||reference.purpose==='lens'?[note]:[];
 }).slice(0,2);
 return {...plan,evidence};
}

/** Anchor codes alone are insufficient: the displayed note must name the films it interprets. */
export function namedAnchorCoverage(plan:CuratedPlan,anchors:Map<string,Film>){
 const claimed=[...new Set(plan.anchors)].flatMap(code=>{const film=anchors.get(code);return film&&filmMentioned(plan.why,film)?[code]:[];});
 const target=Math.min(anchors.size>1?2:1,plan.anchors.length);
 return {named:claimed.length,target,valid:claimed.length>=target};
}

/** Enforce the eight-of-twelve joint-reading target only when the model supplied enough valid rows. */
export function prioritizeSupportedCoverage(ranking:string[],plans:Map<string,CuratedPlan>,anchors:Map<string,Film>){
 const valid=new Set([...plans].filter(([,plan])=>namedAnchorCoverage(plan,anchors).valid).map(([code])=>code));
 const threshold=Math.min(8,plans.size);
 if(valid.size<threshold)return ranking;
 return [...ranking].sort((a,b)=>Number(!valid.has(a))-Number(!valid.has(b)));
}

/** Soft local reranking: variation resolves close calls and never excludes a film. */
export function softlyDiversifyRanking(ranking:string[],candidates:Map<string,CandidateRow>){
 const pending=[...ranking],chosen:string[]=[];
 while(pending.length){
  const window=pending.slice(0,4),recent=chosen.slice(-6).flatMap(code=>{const row=candidates.get(code);return row?[row]:[]});
  const score=(code:string,offset:number)=>{
   const row=candidates.get(code);if(!row)return offset*.55;
   const director=normalizedText(row.film.director),decade=Math.floor(row.film.year/10),country=normalizedText(row.film.country??'');
   const sameDirector=recent.filter(item=>director&&normalizedText(item.film.director)===director).length;
   const sameLens=recent.filter(item=>item.draft.lens===row.draft.lens).length;
   const sameDecade=recent.filter(item=>Math.floor(item.film.year/10)===decade).length;
   const sameCountry=recent.filter(item=>country&&normalizedText(item.film.country??'')===country).length;
   return offset*.55+Math.min(1.3,sameDirector*.65)+Math.min(.36,sameLens*.18)+Math.min(.2,sameDecade*.1)+Math.min(.16,sameCountry*.08);
  };
  const next=window.map((code,offset)=>({code,offset,value:score(code,offset)})).sort((a,b)=>a.value-b.value||a.offset-b.offset)[0];
  pending.splice(next.offset,1);chosen.push(next.code);
 }
 return chosen;
}
