import {createHash} from 'node:crypto';
import {type Film,type ResearchOptions,titleOf} from '../domain';
import {CurationSchema,CuratedFilm,curationSelectionSchema,CURATOR_SELECT_PROMPT} from '../curation-contract';
import {AppError} from './config';
import {curationSettings} from './curation-settings';
import {curatorResponse} from './curator-model';
import {eligiblePreparedCandidates,selectedInput} from './preparation';
import {CriticalDecisionSchema,type Preparation} from './preparation-token';
import {prioritizeSupportedCoverage,sanitizePlanEvidence,softlyDiversifyRanking} from './curation-gates';

export type CriticalDecision=NonNullable<Preparation['decision']>;
function context(preparation:Preparation,films:Film[],seenIds:string[],options:ResearchOptions){
 const selected=selectedInput(films,options.language),verified=eligiblePreparedCandidates(preparation,seenIds,options);
 const seen=[...new Set(seenIds)].sort(),previousIds=[...new Set(options.previousIds)].sort();
 const references=preparation.references.map((reference,i)=>({code:`s${i}`,title:reference.source.title,kind:reference.source.type,discussedFilmIds:reference.anchorIds,excerpt:reference.text}));
 const input={
  language:options.language,intent:options.intent,selected,lenses:preparation.lenses,references,
  reviewedCorpusSignals:(preparation.corpusSignals??[]).map(({id,sourceType,sourceTitle,entities,operation,claim,boundary,hook,matchedFilmIds})=>({id,sourceType,sourceTitle,entities,operation,claim,boundary,hook,matchedFilmIds})),
  freshness:{previousIds,maximumPreviousOverlap:options.intent==='follow'||options.intent==='manual'?5:0},
  verifiedCandidates:verified.map(row=>({code:row.code,id:row.film.id,...row.draft,title:row.film.title,titleKo:row.film.titleKo,displayTitle:titleOf(row.film,options.language),year:row.film.year,director:row.film.director,overview:(row.film.overviewEn||row.film.synopsisEn||'').slice(0,700),previouslyShown:seen.includes(row.film.id),inPreviousList:previousIds.includes(row.film.id)})),
 };
 // Include all historical IDs, even those absent from the current pool. Also
 // bind the actual passages/notes, not only film identities or a timestamp.
 const fingerprint=createHash('sha256').update(JSON.stringify({version:'strada-critical-context-v2',preparation:preparation.fingerprint,seen,input})).digest('hex');
 return {selected,verified,references,input,fingerprint};
}

/** Context identity is independent of request ordering and of writer settings. */
export function decisionFingerprint(preparation:Preparation,films:Film[],seenIds:string[],options:ResearchOptions){return context(preparation,films,seenIds,options).fingerprint;}

/** A signed preparation can carry an expensive decision across server instances. */
export function usableDecision(preparation:Preparation,films:Film[],seenIds:string[],options:ResearchOptions):CriticalDecision|null{
 const parsed=CriticalDecisionSchema.safeParse(preparation.decision);if(!parsed.success)return null;
 const decision=parsed.data,expected=context(preparation,films,seenIds,options);
 if(decision.fingerprint!==curationSettings().stageFingerprints.curate||decision.contextFingerprint!==expected.fingerprint)return null;
 const codes=new Set(expected.verified.map(row=>row.code)),anchors=new Set(expected.selected.map(row=>row.code));
 if(!codes.size||!decision.ranking.length||!decision.recommendations.length||decision.ranking.some(code=>!codes.has(code))||decision.rejected.some(code=>!codes.has(code))||decision.recommendations.some(row=>!codes.has(row.candidate)||row.anchors.some(code=>!anchors.has(code))))return null;
 if(!decision.recommendations.some(row=>!decision.rejected.includes(row.candidate)))return null;
 return decision;
}

/** Same critical selection as an interactive request, without prose expansion. */
export async function criticalPlan(preparation:Preparation,films:Film[],seenIds:string[],options:ResearchOptions,signal:AbortSignal,timeoutMs=40000){
 signal.throwIfAborted();const started=Date.now(),prepared=context(preparation,films,seenIds,options);
 const byCode=new Map(prepared.verified.map(row=>[row.code,row]));
 if(!byCode.size)throw new AppError('NO_NEW_FILMS','No eligible prepared candidates remain. Prepare another film pool.',400);
 const result=await curatorResponse('curate',curationSelectionSchema([...byCode.keys()],prepared.selected.map(row=>row.code),prepared.references.map(row=>row.code)),CURATOR_SELECT_PROMPT,prepared.input,signal,3600,Math.max(1,Math.min(40000,timeoutMs)));
 const output=CurationSchema.safeParse(result.output);if(!output.success)throw new AppError('INVALID_RESEARCH','The final curation was incomplete.');
 let ranking=[...new Set([...output.data.ranking,...byCode.keys()])].filter(code=>byCode.has(code));
 const rejected=[...new Set(output.data.rejected.filter(code=>byCode.has(code)))];
 const filmById=new Map(films.map(film=>[film.id,film])),anchors=new Map(prepared.selected.flatMap(anchor=>{const film=filmById.get(anchor.id);return film?[[anchor.code,film] as const]:[];})),referenceMap=new Map(preparation.references.map((reference,index)=>[`s${index}`,reference]));
 const plans=new Map(output.data.recommendations.flatMap(value=>{const parsed=CuratedFilm.safeParse(value);if(!parsed.success)return [];const candidate=byCode.get(parsed.data.candidate);return candidate?[[parsed.data.candidate,sanitizePlanEvidence(parsed.data,candidate.film,referenceMap,anchors)] as const]:[];}));
 ranking=prioritizeSupportedCoverage(ranking,plans,anchors);
 ranking=softlyDiversifyRanking(ranking,byCode);
 const recommendations=[...plans.values()];
 if(!recommendations.length)throw new AppError('INVALID_RESEARCH','No complete critical decisions were generated.');
 const decision:CriticalDecision={fingerprint:result.settingsFingerprint,contextFingerprint:prepared.fingerprint,ranking,recommendations,rejected};
 signal.throwIfAborted();return {decision,usage:result.usage,elapsedMs:Date.now()-started};
}
