import type {Session} from '../domain';

/** Restore the path itself while withdrawing obsolete evidence privileges. */
export function refreshSavedEvidence(session:Session,currentCorpusVersion?:string):Session{
 return {...session,snapshots:session.snapshots.map(snapshot=>{
  const historical=snapshot.evidenceStatus==='historical'||(snapshot.mode==='live'&&!!currentCorpusVersion&&snapshot.diagnostics?.corpusVersion!==currentCorpusVersion);
  const sources=snapshot.sources.filter(source=>source.type!=='academic'||source.accessLevel==='full_page'||source.accessLevel==='full_text');
  const allowed=new Set(sources.map(source=>source.id));
  const recommendations=snapshot.recommendations.map(recommendation=>{
   const sourceIds=recommendation.sourceIds.filter(id=>allowed.has(id));
   const withdrewEvidence=sourceIds.length!==recommendation.sourceIds.length;
   const connections=recommendation.connections.map(connection=>{
    const ids=connection.sourceIds.filter(id=>allowed.has(id)&&sourceIds.includes(id));
    const relation=!ids.length?'ai_inference' as const:(historical||withdrewEvidence)&&connection.relation==='direct_connection'?'grounded_interpretation' as const:connection.relation;
    return {...connection,sourceIds:ids,relation};
   });
   const restored={...recommendation,sourceIds,connections,...(!sourceIds.length?{contextScope:'discovery' as const}:{})};
   if(withdrewEvidence)delete restored.detailToken;
   return restored;
  });
  const used=new Set(recommendations.flatMap(recommendation=>recommendation.sourceIds));
  return {...snapshot,sources:sources.filter(source=>used.has(source.id)),recommendations,...(historical?{evidenceStatus:'historical' as const}:{})};
 })};
}
