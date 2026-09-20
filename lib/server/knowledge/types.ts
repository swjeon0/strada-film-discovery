export type KnowledgeFilm = {
  key: string;
  title: string;
  year: number;
  director: string;
  aliases: string[];
  externalIds: (string | { provider: string; id: string })[];
};
export type KnowledgeObservation = {
  id: string;
  summary: string;
  summaryKo?: string;
  boundary: string;
  filmKeys: string[];
  subjects: string[];
  kind:
    | "film_reading"
    | "comparison"
    | "contrast"
    | "influence"
    | "co_programming"
    | "historical_context"
    | "incidental_mention";
  passageIds: string[];
};
export type KnowledgeDocument = {
  id: string;
  url: string;
  title: string;
  author: string | null;
  publisher: string;
  type: "criticism" | "academic" | "programme" | "festival";
  language: string;
  publishedAt: string | null;
  checkedAt: string;
  access: "full_page" | "abstract" | "metadata_only";
  rights: {
    mode:
      | "restricted_excerpt"
      | "open_license"
      | "noncommercial"
      | "metadata_only";
    licenseUrl: string | null;
    note: string;
  };
  verification: {
    method: "web_open" | "http_fetch";
    locator: string;
    note: string;
    textUrl?: string;
  };
  films: KnowledgeFilm[];
  passages: { id: string; text: string; locator: string }[];
  observations: KnowledgeObservation[];
  versionId: string;
  contentHash: string;
  reviewStatus: "agent_reviewed" | "human_checked";
  keyMappings: Record<string, string>;
};
export type KnowledgeIndex = {
  version: 1;
  corpusVersion: string;
  builtAt: string;
  documents: KnowledgeDocument[];
  films: KnowledgeFilm[];
  stats: Record<string, unknown>;
};
export type SemanticNeighbors = {
  version: 1;
  corpusVersion: string;
  model: string;
  dimensions: number;
  neighbors: Record<string, { id: string; score: number }[]>;
};
export const observationKey = (documentId: string, observationId: string) =>
  `${documentId}:${observationId}`;

export const identityText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
export const personKey = (value: string) =>
  (
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
    .sort()
    .join(" ");
const STOP = new Set(
  "a an and are as at be by for from he her his in into is it its of on or that the their them they this to was were what which who with film films cinema movie movies director story about 한국어 영화 감독 작품 이야기".split(
    " ",
  ),
);
export function searchTerms(value: string) {
  return [
    ...new Set(
      (
        value
          .normalize("NFKC")
          .toLowerCase()
          .match(/[\p{L}\p{N}]+/gu) ?? []
      ).filter((term) => term.length > 2 && !STOP.has(term)),
    ),
  ];
}
