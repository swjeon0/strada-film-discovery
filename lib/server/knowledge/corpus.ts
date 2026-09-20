import indexData from "../../../research/knowledge/serving-index.json";
import neighborData from "../../../research/knowledge/semantic-neighbors.json";
import type { Film, Language } from "../../domain";
import {
  ContextBundleSchema,
  type ContextBundle,
  type ContextPassage,
} from "../curator/contract";
import type { KnowledgeRepository } from "./repository";
import {
  identityText,
  observationKey,
  personKey,
  searchTerms,
  type KnowledgeDocument,
  type KnowledgeFilm,
  type KnowledgeIndex,
  type KnowledgeObservation,
  type SemanticNeighbors,
} from "./types";

type Entry = {
  id: string;
  document: KnowledgeDocument;
  observation: KnowledgeObservation;
  terms: Set<string>;
};
type Hit = {
  entry: Entry;
  score: number;
  anchors: Set<string>;
  directAnchors: Set<string>;
  role: "selected_reading" | "related_context";
};
export const CONTEXT_LIMITS = {
  passages: 16,
  characters: 15_000,
  perDocument: 2,
};

/** Read-only serving replica compiled from the normalized offline database.
 * Entity postings, text postings and precomputed semantic neighbours keep the
 * request path free of network searches, ingestion and embedding API calls. */
export class CorpusKnowledgeRepository implements KnowledgeRepository {
  private readonly data: KnowledgeIndex;
  private readonly neighbors: SemanticNeighbors;
  private readonly films = new Map<string, KnowledgeFilm>();
  private readonly filmAliases = new Map<string, Set<string>>();
  private readonly externalIds = new Map<string, Set<string>>();
  private readonly entries = new Map<string, Entry>();
  private readonly byFilm = new Map<string, Entry[]>();
  private readonly byTerm = new Map<string, Set<string>>();
  constructor(
    data: KnowledgeIndex = indexData as unknown as KnowledgeIndex,
    neighbors: SemanticNeighbors = neighborData as SemanticNeighbors,
  ) {
    if (data.version !== 1 || !data.corpusVersion)
      throw new Error("Invalid knowledge serving index.");
    this.data = data;
    // A stale semantic graph must never connect a newly revised corpus silently.
    this.neighbors =
      neighbors.corpusVersion === data.corpusVersion
        ? neighbors
        : { ...neighbors, neighbors: {} };
    for (const film of data.films) {
      this.films.set(film.key, film);
      for (const name of [film.title, ...film.aliases])
        this.addPosting(this.filmAliases, identityText(name), film.key);
      for (const value of film.externalIds) {
        const id =
          typeof value === "string"
            ? value
            : `${value.provider === "wikidata" ? "wd" : value.provider}:${value.id}`;
        this.addPosting(this.externalIds, id, film.key);
      }
    }
    for (const document of data.documents) {
      if (
        document.access === "metadata_only" ||
        document.rights.mode === "metadata_only"
      )
        continue;
      // Academic abstracts are excluded from the product, including stale replicas.
      if (document.type === "academic" && document.access !== "full_page")
        continue;
      for (const observation of document.observations) {
        if (observation.kind === "incidental_mention") continue;
        if (
          !observation.passageIds.some((id) =>
            document.passages.some((p) => p.id === id),
          )
        )
          continue;
        const id = observationKey(document.id, observation.id),
          entry: Entry = {
            id,
            document,
            observation,
            terms: new Set(
              searchTerms(
                [
                  observation.summary,
                  observation.summaryKo,
                  ...observation.subjects,
                ].join(" "),
              ),
            ),
          };
        this.entries.set(id, entry);
        for (const key of observation.filmKeys) {
          const bucket = this.byFilm.get(key) ?? [];
          bucket.push(entry);
          this.byFilm.set(key, bucket);
        }
        for (const term of entry.terms) this.addPosting(this.byTerm, term, id);
      }
    }
  }
  private addPosting(
    index: Map<string, Set<string>>,
    key: string,
    value: string,
  ) {
    if (!key) return;
    const bucket = index.get(key) ?? new Set<string>();
    bucket.add(value);
    index.set(key, bucket);
  }
  fingerprint() {
    return `${this.data.corpusVersion.slice(0, 16)}:${this.neighbors.model}:${Object.keys(this.neighbors.neighbors).length}`;
  }
  stats() {
    return {
      ...this.data.stats,
      corpusVersion: this.data.corpusVersion,
      semanticObservations: Object.keys(this.neighbors.neighbors).length,
      storage: "versioned-sqlite-with-bundled-read-replica",
      humanCurationCases: 0,
    };
  }
  private matchFilm(film: Film) {
    const external = [
      film.id,
      ...(film.wikidataId ? [`wd:${film.wikidataId}`] : []),
    ].flatMap((id) => [...(this.externalIds.get(id) ?? [])]);
    if (external.length) return [...new Set(external)];
    const aliases = [
      film.title,
      film.titleKo,
      film.originalTitle,
      ...(film.aliases ?? []),
    ].filter((s): s is string => !!s);
    const keys = new Set(
      aliases.flatMap((name) => [
        ...(this.filmAliases.get(identityText(name)) ?? []),
      ]),
    );
    const candidates = [...keys].filter((key) => {
      const row = this.films.get(key)!;
      return (
        Math.abs(row.year - film.year) <= 1 &&
        !!film.director &&
        personKey(row.director) === personKey(film.director)
      );
    });
    return candidates.length === 1 ? candidates : [];
  }
  async buildContext(
    selected: Film[],
    language: Language,
  ): Promise<ContextBundle> {
    const ordered = [...selected].sort((a, b) => a.id.localeCompare(b.id)),
      hits = new Map<string, Hit>(),
      matches = new Map(ordered.map((film) => [film.id, this.matchFilm(film)]));
    const add = (
      entry: Entry,
      score: number,
      anchor: string,
      role: Hit["role"],
    ) => {
      const old = hits.get(entry.id);
      if (old) {
        old.score = Math.max(old.score, score);
        old.anchors.add(anchor);
        if (role === "selected_reading") {
          old.role = role;
          old.directAnchors.add(anchor);
        }
      } else
        hits.set(entry.id, {
          entry,
          score,
          anchors: new Set([anchor]),
          directAnchors: new Set(role === "selected_reading" ? [anchor] : []),
          role,
        });
    };
    for (const film of ordered) {
      const direct = [
        ...new Map(
          (matches.get(film.id) ?? [])
            .flatMap((key) => this.byFilm.get(key) ?? [])
            .map((entry) => [entry.id, entry]),
        ).values(),
      ];
      for (const entry of direct) add(entry, 20, film.id, "selected_reading");
      // Keep independent readings separate rather than averaging all seed films
      // into a single vector. These neighbours retrieve context, never rank films.
      for (const entry of direct)
        for (const neighbor of this.neighbors.neighbors[entry.id] ?? []) {
          const related = this.entries.get(neighbor.id);
          if (related && neighbor.score >= 0.48)
            add(related, 6 * neighbor.score, film.id, "related_context");
        }
      const terms = direct.length
        ? new Set(
            direct.flatMap((entry) =>
              entry.observation.subjects.flatMap(searchTerms),
            ),
          )
        : new Set(
            searchTerms(
              [
                film.overviewEn,
                film.overviewKo,
                film.synopsisEn,
                film.synopsisKo,
              ]
                .filter(Boolean)
                .join(" "),
            ),
          );
      const lexical = new Map<string, { score: number; matched: number }>();
      // Rank terms by specificity, not record insertion order. All matches enter
      // scoring before the bounded context is chosen, so later imports stay visible.
      const queryTerms = [...terms]
        .filter((term) => this.byTerm.has(term))
        .sort(
          (a, b) =>
            this.byTerm.get(a)!.size - this.byTerm.get(b)!.size ||
            a.localeCompare(b),
        )
        .slice(0, 80);
      for (const term of queryTerms) {
        const posting = this.byTerm.get(term)!;
        const idf = Math.log(1 + this.entries.size / (1 + posting.size));
        for (const id of posting) {
          const row = lexical.get(id) ?? { score: 0, matched: 0 };
          row.score += idf;
          row.matched++;
          lexical.set(id, row);
        }
      }
      for (const [id, row] of [...lexical]
        .filter(([, row]) => row.matched >= 2)
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 8))
        add(
          this.entries.get(id)!,
          Math.min(5, row.score / 3),
          film.id,
          "related_context",
        );
    }
    const ranked = [...hits.values()].sort(
      (a, b) =>
        b.score +
          Math.log1p(b.anchors.size) -
          a.score -
          Math.log1p(a.anchors.size) || a.entry.id.localeCompare(b.entry.id),
    );
    const chosen: Hit[] = [],
      seen = new Set<string>(),
      perDoc = new Map<string, number>();
    let characters = 0;
    const take = (hit: Hit) => {
      if (
        seen.has(hit.entry.id) ||
        chosen.length >= CONTEXT_LIMITS.passages ||
        (perDoc.get(hit.entry.document.id) ?? 0) >= CONTEXT_LIMITS.perDocument
      )
        return false;
      const passage = this.passage(hit, matches, language),
        size = JSON.stringify(passage).length;
      if (characters + size > CONTEXT_LIMITS.characters) return false;
      chosen.push(hit);
      seen.add(hit.entry.id);
      perDoc.set(
        hit.entry.document.id,
        (perDoc.get(hit.entry.document.id) ?? 0) + 1,
      );
      characters += size;
      return true;
    };
    // Equal opportunity for each covered input, independent of trail order.
    for (const film of ordered) {
      const hit = ranked.find((h) => h.directAnchors.has(film.id));
      if (hit) take(hit);
    }
    // Merge direct evidence and neighbourhoods with diminishing returns for an
    // already represented film/document. No film-category or diversity quota.
    const remaining = ranked.slice(0, 384);
    while (remaining.length && chosen.length < CONTEXT_LIMITS.passages) {
      remaining.sort(
        (a, b) =>
          this.marginal(b, chosen) - this.marginal(a, chosen) ||
          a.entry.id.localeCompare(b.entry.id),
      );
      take(remaining.shift()!);
    }
    return ContextBundleSchema.parse({
      version: 1,
      corpusVersion: this.data.corpusVersion,
      builtAt: this.data.builtAt,
      selectedFilmIds: ordered.map((f) => f.id),
      passages: chosen.map((hit) => this.passage(hit, matches, language)),
      legacyNotes: [],
    });
  }
  private marginal(hit: Hit, chosen: Hit[]) {
    const represented = chosen.filter((other) =>
      [...hit.anchors].some((id) => other.anchors.has(id)),
    ).length;
    const sameDocument = chosen.filter(
      (other) => other.entry.document.id === hit.entry.document.id,
    ).length;
    return (
      (hit.score + Math.log1p(hit.anchors.size)) /
      (1 + represented * 0.45 + sameDocument * 2)
    );
  }
  private passage(
    hit: Hit,
    matches: Map<string, string[]>,
    language: Language,
  ): ContextPassage {
    const { document, observation } = hit.entry,
      quotes = observation.passageIds.flatMap((id) =>
        document.passages.filter((p) => p.id === id),
      );
    const quote = quotes[0],
      identityKeys = new Set(observation.filmKeys),
      filmIds = new Set(observation.filmKeys);
    for (const [runtimeId, keys] of matches)
      if (keys.some((key) => identityKeys.has(key))) filmIds.add(runtimeId);
    return {
      id: hit.entry.id,
      documentId: document.id,
      title: document.title,
      author: document.author,
      publisher: document.publisher,
      url: document.url,
      type: document.type,
      locator: quote.locator.slice(0, 500),
      excerpt: quote.text,
      filmIds: [...filmIds],
      subjects: observation.subjects,
      contentKind: "exact_passage",
      reviewState: document.reviewStatus,
      rights:
        document.rights.mode === "open_license"
          ? "open_license"
          : document.rights.mode === "noncommercial"
            ? "noncommercial"
            : "quotation_for_research",
      observation:
        language === "ko"
          ? observation.summaryKo || observation.summary
          : observation.summary,
      observationEn: observation.summary,
      observationKo: observation.summaryKo,
      boundary: observation.boundary,
      connectionKind: observation.kind,
      accessLevel: document.access,
      versionId: document.versionId,
      checkedAt: document.checkedAt,
      sourceLanguage: document.language,
      publishedAt: document.publishedAt,
      retrievalRole: hit.role,
      retrievedFor: [...hit.anchors].sort(),
      relatedFilms: observation.filmKeys.flatMap((key) => {
        const film = this.films.get(key);
        return film
          ? [
              {
                id: key,
                title: film.title,
                year: film.year,
                director: film.director,
                aliases: film.aliases,
              },
            ]
          : [];
      }),
    };
  }
}

let productionRepository: CorpusKnowledgeRepository | undefined;
export function knowledgeRepository() {
  return (productionRepository ??= new CorpusKnowledgeRepository());
}
