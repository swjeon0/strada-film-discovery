import type { Film, Language, ResearchIntent, Session } from "../domain";
import {
  discoveryHistoryContext,
  type DiscoveredFilm,
} from "../discovery-context";

export type DiscoveryInput = {
  requestId: string;
  baseSnapshotId: string | null;
  seeds: string[];
  trail: string[];
  language: Language;
  intent: ResearchIntent;
  previousIds: string[];
  seenIds: string[];
  discoveredFilms: DiscoveredFilm[];
};

export function discoveryInput(
  session: Session,
  language: Language,
  intent: ResearchIntent,
  film?: Film,
): DiscoveryInput {
  const base = session.snapshots[session.cursor];
  const continuing = intent !== "initial";
  const seeds = continuing ? (base?.seeds ?? []) : session.seedDraft;
  const trail = continuing ? [...(base?.trail ?? [])] : [];

  if ((intent === "follow" || intent === "manual") && film) trail.push(film);

  return {
    requestId: crypto.randomUUID(),
    baseSnapshotId: base?.id ?? null,
    seeds: seeds.map((item) => item.id),
    trail: trail.map((item) => item.id),
    language,
    intent,
    previousIds: continuing
      ? (base?.recommendations.map((item) => item.film.id) ?? [])
      : [],
    ...discoveryHistoryContext(session, continuing),
  };
}
