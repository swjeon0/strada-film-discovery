"use client";
import { useEffect, useState } from "react";
import { ArrowRight, ArrowUpRight, X, LoaderCircle } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { FilmPoster } from "./film-poster";
import {
  titleOf,
  type Film,
  type Snapshot,
  type Recommendation,
  type Language,
  type Connection,
} from "@/lib/domain";
import { translate, localizeTitles, apiMessage } from "@/lib/i18n";
import { collection } from "@/lib/catalogue";
const explanationCache = new Map<string, string[]>();
export function FilmDrawer({
  snapshot,
  detail,
  language,
  onClose,
  onFollow,
  onCancel,
  busy,
  error,
  replacesLater,
  lastPoster,
}: {
  snapshot?: Snapshot;
  detail?: Recommendation;
  language: Language;
  onClose: () => void;
  onFollow: (film: Film) => void;
  onCancel: () => void;
  busy: boolean;
  error: string;
  replacesLater: boolean;
  lastPoster: React.RefObject<HTMLElement | null>;
}) {
  const tr = (en: string, ko: string) => translate(language, en, ko);
  const [metadata, setMetadata] = useState<Record<string, Film>>({});
  const [loading, setLoading] = useState(false);
  const [metadataError, setMetadataError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [explanations, setExplanations] = useState<Record<string, string[]>>(
    {},
  );
  const [explanationFailure, setExplanationFailure] = useState<{
    key: string;
    code?: string;
  } | null>(null);
  const [explanationRetry, setExplanationRetry] = useState(0);
  const explanationKey = detail?.detailToken
    ? `${language}:${detail.detailToken}`
    : "";
  const explanationParagraphs =
    explanations[explanationKey] ?? explanationCache.get(explanationKey);
  const explanationError =
    explanationFailure?.key === explanationKey && !!explanationKey;
  const explanationLoading =
    !!explanationKey && !explanationParagraphs && !explanationError;
  useEffect(() => {
    if (!detail?.detailToken) return;
    const key = `${language}:${detail.detailToken}`,
      cached = explanationCache.get(key);
    if (cached) return;
    const controller = new AbortController();
    fetch("/api/recommendations/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: detail.detailToken, language }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const error = (await response.json().catch(() => ({}))) as {
            error?: { code?: string };
          };
          throw Object.assign(new Error("Explanation unavailable"), {
            code: error.error?.code,
          });
        }
        const data = (await response.json()) as {
          paragraphs?: unknown;
          language?: string;
        };
        if (
          data.language !== language ||
          !Array.isArray(data.paragraphs) ||
          !data.paragraphs.length ||
          !data.paragraphs.every(
            (p) => typeof p === "string" && p.trim().length > 0,
          )
        )
          throw new Error("Invalid explanation");
        const paragraphs = data.paragraphs as string[];
        if (!controller.signal.aborted) {
          if (explanationCache.size >= 120)
            explanationCache.delete(explanationCache.keys().next().value!);
          explanationCache.set(key, paragraphs);
          setExplanations((current) => ({ ...current, [key]: paragraphs }));
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setExplanationFailure({
            key,
            code:
              error instanceof Error
                ? (error as Error & { code?: string }).code
                : undefined,
          });
      });
    return () => controller.abort();
  }, [detail?.detailToken, language, explanationRetry]);
  const film = detail ? (metadata[detail.film.id] ?? detail.film) : undefined;
  const discoveryScope = detail?.contextScope === "discovery";
  useEffect(() => {
    if (!detail) return;
    const existing = detail.film;
    if (language === "ko" ? existing.synopsisKo : existing.synopsisEn) return;
    const controller = new AbortController();
    setLoading(true);
    setMetadataError(false);
    fetch(
      `/api/films/${encodeURIComponent(detail.film.id)}?language=${language}`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error("Metadata unavailable");
        const data = (await r.json()) as { film: Film };
        if (!controller.signal.aborted)
          setMetadata((current) => ({
            ...current,
            [detail.film.id]: {
              ...(current[detail.film.id] ?? existing),
              ...data.film,
            },
          }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setMetadataError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [detail, language, retry]);
  const names = [
    ...collection,
    ...(snapshot?.seeds ?? []),
    ...(snapshot?.trail ?? []),
    ...(snapshot?.recommendations.map((r) => r.film) ?? []),
  ];
  const local = (text: string) => localizeTitles(text, names, language);
  const anchorIds = new Set(
    detail?.connections.map((connection) => connection.anchorId) ?? [],
  );
  const participatingFilms = [
    ...(snapshot?.seeds ?? []),
    ...(snapshot?.trail ?? []),
  ].filter((selected) => anchorIds.has(selected.id));
  const label = (relation: Connection["relation"]) =>
    relation === "ai_inference"
      ? tr("AI curation · no verified source", "AI 큐레이션 · 확인된 출처 없음")
      : relation === "direct_connection"
        ? tr("A documented connection", "출처에서 확인한 연결")
        : relation === "curatorial_association"
          ? tr("A curatorial route", "큐레이션으로 이어지는 길")
          : tr(
              "A source-informed STRADA reading",
              "자료를 참고한 STRADA의 해석",
            );
  const synopsis = film
    ? language === "ko"
      ? film.synopsisKo || film.synopsisEn
      : film.synopsisEn || film.synopsisKo
    : "";
  const synopsisSource = film
    ? language === "ko" && film.synopsisKo
      ? film.synopsisKoSource
      : film.synopsisEn
        ? film.synopsisEnSource
        : film.synopsisKoSource
    : "";
  const intro = film
    ? language === "ko"
      ? film.overviewKo || film.overviewEn
      : film.overviewEn || film.overviewKo
    : "";
  const source =
    synopsisSource ||
    (language === "ko" && film?.overviewKo
      ? film.overviewKoSource
      : film?.overviewEnSource);
  const typeLabel = {
    academic: tr("Academic", "학술"),
    criticism: tr("Criticism", "비평"),
    festival: tr("Programme", "영화제"),
    catalogue: tr("Curation", "큐레이션"),
  };
  return (
    <Sheet
      open={!!detail}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="film-drawer"
        showCloseButton={false}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          lastPoster.current?.focus({ preventScroll: true });
        }}
      >
        {detail && film && snapshot && (
          <>
            <div className="drawer-top">
              <span className="eyebrow">
                {tr("ALONG THIS ROUTE", "이 길에서 만난 영화")}
              </span>
              <button
                className="icon-button"
                aria-label={tr("Close film details", "영화 정보 닫기")}
                onClick={onClose}
              >
                <X size={21} />
              </button>
            </div>
            <div className="drawer-scroll">
              <div className="detail-identity">
                <div className="detail-poster">
                  <FilmPoster
                    film={{ ...film, title: titleOf(film, language) }}
                  />
                </div>
                <div>
                  <SheetTitle className="film-title">
                    {titleOf(film, language)}
                  </SheetTitle>
                  {language === "ko" && film.titleKo && (
                    <p className="film-title-original">{film.title}</p>
                  )}
                  <SheetDescription className="film-meta">
                    {film.director} · {film.year}
                  </SheetDescription>
                  <p className="film-country">
                    {film.country}
                    {film.runtime
                      ? ` · ${film.runtime}${tr(" min", "분")}`
                      : ""}
                  </p>
                </div>
              </div>
              <section className="synopsis-section">
                <h2>
                  {synopsis
                    ? tr("Synopsis", "줄거리")
                    : tr("About the film", "영화 소개")}
                </h2>
                {synopsis || intro ? (
                  <p>{synopsis || intro}</p>
                ) : (
                  <p>
                    {loading
                      ? tr(
                          "Loading the synopsis…",
                          "줄거리를 불러오고 있습니다…",
                        )
                      : tr(
                          "The database has no synopsis for this film yet.",
                          "DB에 등록된 줄거리가 아직 없습니다.",
                        )}
                  </p>
                )}
                {language === "ko" && synopsis && !film.synopsisKo && (
                  <small className="copy-language-note">
                    {tr("", "한국어 줄거리가 없어 영문 원문을 표시합니다.")}
                  </small>
                )}
                {source && (
                  <a
                    className="synopsis-credit"
                    href={source}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {source.includes("wikipedia.org")
                      ? "Wikipedia · CC BY-SA"
                      : tr("Database synopsis", "DB 줄거리")}
                    <ArrowUpRight size={12} />
                  </a>
                )}
                {metadataError && (
                  <button
                    className="text-button"
                    onClick={() => setRetry((n) => n + 1)}
                  >
                    {tr("Retry synopsis", "줄거리 다시 불러오기")}
                  </button>
                )}
              </section>
              <section className="why-section">
                <h2>{tr("Why this film", "이 영화로 이어지는 이유")}</h2>
                {detail.curation?.lens &&
                  (!snapshot.language || snapshot.language === language) && (
                    <p className="curation-lens">
                      {local(detail.curation.lens)}
                    </p>
                  )}
                <div className="connection-anchor">
                  <span>
                    {detail.curation
                      ? tr(
                          "A reading of your chosen films",
                          "선택한 영화들의 연결",
                        )
                      : discoveryScope
                        ? tr("The films you chose", "지금까지 고른 영화들")
                        : local(detail.connections[0].anchorTitle)}
                  </span>
                  <ArrowRight size={14} />
                  <span>{titleOf(film, language)}</span>
                </div>
                {detail.curation && participatingFilms.length > 0 && (
                  <div
                    className="joint-film-titles"
                    aria-label={tr(
                      "Selected films in this reading",
                      "이 연결에 함께 읽은 영화",
                    )}
                  >
                    {participatingFilms.map((selected) => (
                      <span key={selected.id}>
                        {titleOf(selected, language)}
                      </span>
                    ))}
                  </div>
                )}
                <p className="why-text">
                  {local(
                    explanationParagraphs?.join("\n\n") ||
                      (language === "ko"
                        ? detail.connections[0].whyKo ||
                          detail.connections[0].why
                        : detail.connections[0].why),
                  )}
                </p>
                {explanationLoading && (
                  <p className="explanation-progress" role="status">
                    <LoaderCircle size={13} className="spinning" />
                    {tr(
                      "Reading this connection more closely…",
                      "이 연결을 더 자세히 읽고 있습니다…",
                    )}
                  </p>
                )}
                {explanationError &&
                  (explanationFailure?.code === "DETAIL_EXPIRED" ? (
                    <p className="explanation-progress">
                      {apiMessage("DETAIL_EXPIRED", language)}
                    </p>
                  ) : (
                    <button
                      className="text-button explanation-retry"
                      onClick={() => {
                        setExplanationFailure(null);
                        setExplanationRetry((value) => value + 1);
                      }}
                    >
                      {tr(
                        "Read more about this connection",
                        "이 연결을 더 자세히 읽기",
                      )}
                    </button>
                  ))}
                <span
                  className={`relation-label ${detail.connections[0].relation}`}
                >
                  <span />
                  {label(detail.connections[0].relation)}
                </span>
                {!detail.curation && detail.connections.length > 1 && (
                  <>
                    <p className="overlap-label">
                      {tr(
                        `Connected to ${new Set(detail.connections.map((c) => c.anchorId)).size} films on your path`,
                        `고른 영화 ${new Set(detail.connections.map((c) => c.anchorId)).size}편과 연결됩니다`,
                      )}
                    </p>
                    <Accordion
                      type="single"
                      collapsible
                      className="other-connections"
                    >
                      <AccordionItem value="more">
                        <AccordionTrigger>
                          {tr(
                            "More connections along your path",
                            "현재 경로의 다른 연결 보기",
                          )}
                        </AccordionTrigger>
                        <AccordionContent>
                          {detail.connections.slice(1).map((c) => (
                            <div key={c.anchorId}>
                              <strong>{local(c.anchorTitle)}</strong>
                              <p>
                                {local(
                                  language === "ko" ? c.whyKo || c.why : c.why,
                                )}
                              </p>
                              <small>{label(c.relation)}</small>
                            </div>
                          ))}
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </>
                )}
              </section>
              <section className="evidence-section">
                <div className="evidence-heading">
                  <h2>{tr("Read the sources", "연결의 근거")}</h2>
                  <span>{detail.sourceIds.length}</span>
                </div>
                {snapshot.evidenceStatus === "historical" && (
                  <p className="context-note">
                    {tr(
                      "This saved route predates the current source collection. Its source context has not been rechecked; generate a new route for current evidence.",
                      "이 경로는 현재 문헌 DB보다 이전에 저장되었습니다. 당시 자료는 다시 확인되지 않았으므로, 최신 근거는 새 추천에서 확인해 주세요.",
                    )}
                  </p>
                )}
                {!detail.sourceIds.length && (
                  <p className="ai-evidence-note">
                    {discoveryScope
                      ? tr(
                          "AI read the films you chose together. This is a curatorial proposal; no supporting source was verified for this request.",
                          "지금까지 고른 영화들을 함께 읽어 제안한 큐레이션입니다. 이번 요청에서 이 연결을 뒷받침하는 출처는 확인하지 못했습니다.",
                        )
                      : tr(
                          "We could not verify a supporting source for this route. This recommendation is the AI’s own curatorial proposal, offered as another direction to explore.",
                          "이 연결을 뒷받침하는 출처를 확인하지 못했습니다. AI가 제안한 큐레이션이며, 다음 탐색 방향으로 살펴볼 수 있습니다.",
                        )}
                  </p>
                )}
                {detail.sourceIds
                  .map((id) => snapshot.sources.find((s) => s.id === id))
                  .filter((s) => !!s)
                  .map((s, i) => (
                    <article className="evidence-card" key={s.id}>
                      <div className="evidence-kicker">
                        <span>{String(i + 1).padStart(2, "0")}</span>
                        <span>{typeLabel[s.type]}</span>
                        {s.accessLevel === "abstract" && (
                          <em>{tr("Abstract", "초록")}</em>
                        )}
                      </div>
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="source-title"
                      >
                        {s.title}
                        <ArrowUpRight size={17} />
                      </a>
                      <p className="source-byline">
                        {[s.author, s.publisher, s.date?.slice(0, 4)]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <p className="source-summary">
                        {local(
                          language === "ko"
                            ? s.summaryKo || s.summary
                            : s.summary,
                        )}
                      </p>
                      {s.locator && (
                        <p className="source-locator">{s.locator}</p>
                      )}
                      {s.boundary && (
                        <p className="context-note">
                          <strong>
                            {tr(
                              "Scope of this reading · STRADA annotation",
                              "해석 범위 · STRADA의 정리",
                            )}
                          </strong>
                          <br />
                          {s.boundary}
                        </p>
                      )}
                      {s.excerpt && (
                        <div className="source-excerpt">
                          <span>{tr("From the source", "원문 발췌")}</span>
                          <blockquote>{s.excerpt}</blockquote>
                        </div>
                      )}
                      {s.reviewStatus === "agent_reviewed" && (
                        <small className="context-note">
                          {tr(
                            "Source reading checked by AI; not yet reviewed by a human editor.",
                            "AI가 원문을 확인해 정리한 자료이며, 사람 편집자의 검수는 아직 거치지 않았습니다.",
                          )}
                        </small>
                      )}
                      {s.scope === "interpretive_context" && (
                        <small className="context-note">
                          {tr(
                            "A reading of a film discussed here. The connection between films is STRADA’s interpretation.",
                            "작품을 이해하는 자료입니다. 영화 사이의 연결은 STRADA의 해석입니다.",
                          )}
                        </small>
                      )}
                      {s.scope === "programme_context" && (
                        <small className="context-note">
                          {tr(
                            "Programme context, not evidence of similarity.",
                            "영화제의 맥락이며, 유사성을 입증하는 근거는 아닙니다.",
                          )}
                        </small>
                      )}
                    </article>
                  ))}
              </section>
              <p className="evidence-footnote">
                {tr(
                  "Documented connections, STRADA readings, and source-free AI proposals are labeled separately. A connection does not imply direct influence.",
                  "출처에서 확인한 연결, STRADA의 해석, 출처 없이 제안한 AI 큐레이션을 구분합니다. 연결이 곧 직접적인 영향 관계를 뜻하지는 않습니다.",
                )}
              </p>
            </div>
            <div className="drawer-action">
              {replacesLater && (
                <p className="replace-note">
                  {tr(
                    "Continuing here replaces the later steps after the next results are ready.",
                    "다음 추천이 준비되면 이 지점 이후의 경로가 바뀝니다.",
                  )}
                </p>
              )}
              {error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
              {busy && (
                <p className="pending-note" role="status">
                  {tr(
                    "Finding the next route. Your current path is kept.",
                    "다음 길을 찾고 있습니다. 현재 경로는 그대로 보관됩니다.",
                  )}
                </p>
              )}
              <div className="follow-buttons">
                <button
                  className="primary follow"
                  disabled={busy}
                  onClick={() => onFollow(film)}
                >
                  {busy ? (
                    <>
                      <LoaderCircle className="spinning" size={18} />
                      {tr("Finding a route…", "다음 길 찾는 중…")}
                    </>
                  ) : (
                    <>
                      {tr("Continue with this film", "이 영화로 이어가기")}
                      <ArrowRight size={18} />
                    </>
                  )}
                </button>
                {busy && (
                  <button className="secondary" onClick={onCancel}>
                    {tr("Cancel", "취소")}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
