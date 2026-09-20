'use client';
import type {Language,Snapshot} from '@/lib/domain';

export function RunInspector({snapshot,language}:{snapshot:Snapshot;language:Language}){
 const data=snapshot.diagnostics;if(!data)return null;
 const ko=language==='ko',seconds=(ms:number|undefined)=>`${((ms??0)/1000).toFixed(2)}s`;
 const selected=[...snapshot.seeds,...snapshot.trail];
 function download(){
  const report={format:'strada-curation-review-v1',createdAt:snapshot.createdAt,action:snapshot.action,language:snapshot.language,
   selected:selected.map(({id,title,titleKo,year,director})=>({id,title,titleKo,year,director})),diagnostics:data,
   recommendations:snapshot.recommendations.map(({detailToken:_token,...recommendation})=>{void _token;return recommendation;}),sources:snapshot.sources};
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=`strada-review-${snapshot.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 const timings=data.timings??{};
 return <details className="run-inspector">
  <summary>{ko?'탐색 기록':'Discovery record'} · {seconds(data.clientMs??timings.totalMs)} · {ko?`참고 문헌 ${data.usedDocuments}개`:`${data.usedDocuments} sources used`}</summary>
  <div className="run-inspector-content">
   <p>{ko?'요청부터 결과 수신까지의 시간입니다. 포스터 다운로드 시간은 포함하지 않습니다.':'Time from request to receiving results; poster downloads are separate.'}</p>
   <dl><div><dt>{ko?'영화 정보':'Film metadata'}</dt><dd>{seconds(timings.metadataMs)}</dd></div><div><dt>{ko?'문헌 검색':'Literature retrieval'}</dt><dd>{seconds(timings.contextMs)}</dd></div><div><dt>{ko?'큐레이션':'Curation'}</dt><dd>{seconds(timings.modelMs)}</dd></div><div><dt>{ko?'실제 영화 확인':'Film verification'}</dt><dd>{seconds(timings.candidateResolutionMs)}</dd></div>{data.repairAttempted&&<div><dt>{ko?'미확인 작품 교체':'Identity repair'}</dt><dd>{seconds(timings.repairMs)}</dd></div>}</dl>
   <p>{data.model} · {ko?`문헌 ${data.documents}개 중 ${data.retrievedDocuments}개를 모델에 제공 · 선택작 ${selected.length}편 중 ${data.coveredFilmIds.length}편의 직접 자료 포함`:`${data.retrievedDocuments} of ${data.documents} documents supplied · direct literature for ${data.coveredFilmIds.length}/${selected.length} selected films`}</p>
   <p className="run-version">{ko?'자료 버전':'Corpus version'} {data.corpusVersion.slice(0,12)}</p>
   <button type="button" className="text-button" onClick={download}>{ko?'이 추천의 테스트 기록 저장':'Download this recommendation for review'}</button>
  </div>
 </details>;
}
