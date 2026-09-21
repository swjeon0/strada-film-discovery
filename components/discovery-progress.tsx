"use client";
import { useEffect, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import type { Film, Language } from "@/lib/domain";
import type { DiscoveryProgress as Progress } from "@/lib/client/recommendation-stream";
import { FilmPoster } from "./film-poster";

export function DiscoveryProgress({ progress, films, language, startedAt, onCancel }: {
  progress: Progress;
  films: Film[];
  language: Language;
  startedAt: number;
  onCancel: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const tick = () => setSeconds(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const ko = language === "ko";
  const steps = ko ? ["영화 읽기", "문헌 살피기", "연결 고르기", "작품 확인"]
    : ["Read films", "Read sources", "Curate", "Verify films"];
  const current = ({ metadata: 0, context: 1, curating: 2, verifying: 3, repairing: 3 })[progress.stage];
  const label = ({
    metadata: ko ? "고른 영화에서 출발합니다" : "Beginning with your films",
    context: ko ? "비평과 프로그램 노트를 살피고 있습니다" : "Reading criticism and programme notes",
    curating: ko ? "다음으로 볼 이유가 있는 열두 편을 고르고 있습니다" : "Choosing twelve films worth seeing next",
    verifying: ko ? "선정한 작품의 정보를 확인하고 있습니다" : "Checking the selected films",
    repairing: ko ? "확인이 필요한 작품을 다시 살피고 있습니다" : "Rechecking films that need a closer look",
  })[progress.stage];
  return (
    <section className="discovery-progress" aria-label={ko ? "추천 진행 상황" : "Curation progress"}>
      <div className="progress-heading">
        <div className="progress-films" aria-hidden="true">
          {films.slice(-4).map(film => <span key={film.id}><FilmPoster film={film} decorative /></span>)}
        </div>
        <div className="progress-copy" role="status" aria-live="polite">
          <strong>{label}</strong>
          <span>{seconds >= 20
            ? (ko ? "조금 더 시간이 걸리고 있습니다. 완료되면 자동으로 열립니다." : "Taking a little longer. The films will open when ready.")
            : (ko ? "영화가 만나면서 생기는 새로운 관점을 찾는 중입니다." : "Looking for new perspectives where these films meet.")}</span>
        </div>
        <span className="progress-time" aria-hidden="true">{seconds}s</span>
      </div>
      <ol className="progress-steps">
        {steps.map((step, index) => <li key={step} className={index < current ? "done" : index === current ? "active" : ""} aria-current={index === current ? "step" : undefined}>
          <span>{index < current ? <Check size={12} /> : index === current ? <LoaderCircle size={12} className="spinning" /> : index + 1}</span>{step}
        </li>)}
      </ol>
      <div className="progress-track" aria-hidden="true"><span /></div>
      <div className="progress-bottom">
        <span>{ko ? "완성된 열두 편을 함께 보여드립니다." : "All twelve films will appear together."}</span>
        <button className="text-button" onClick={onCancel}>{ko ? "취소" : "Cancel"}</button>
      </div>
    </section>
  );
}
