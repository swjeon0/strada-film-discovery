import type { Film } from "../../domain";
import { resolveCandidates } from "../metadata";
import type { Budget } from "../tmdb";
import type { CuratorDecision, CuratorOutput } from "./contract";

export type ProposalResolver = (
  candidates: { title: string; year: number; director: string }[],
  budget: Budget,
) => Promise<(Film | null)[]>;
export class CuratorIdentityError extends Error {
  constructor(
    public details: {
      unresolved: {
        index: number;
        title: string;
        year: number;
        director: string;
      }[];
      duplicateIds: string[];
      excludedIds: string[];
      duplicateIndexes: number[];
      excludedIndexes: number[];
      invalidIndexes: number[];
      missingAnchorIds: string[];
    },
  ) {
    super("CURATOR_IDENTITY_RESOLUTION_FAILED");
  }
}

export async function resolveCuratorOutput(
  output: CuratorOutput,
  excludedIds: string[],
  signal: AbortSignal,
  resolver: ProposalResolver = resolveCandidates,
): Promise<CuratorDecision> {
  const budget: Budget = { remaining: 80, signal };
  const proposals = output.recommendations;
  const ids = new Set<string>(),
    duplicateIds: string[] = [],
    duplicateIndexes: number[] = [],
    resolvedExcluded: string[] = [],
    excludedIndexes: number[] = [],
    excluded = new Set(excludedIds),
    accepted: {
      film: Film;
      proposal: CuratorOutput["recommendations"][number];
    }[] = [];
  const unresolved: {
    index: number;
    title: string;
    year: number;
    director: string;
  }[] = [];
  const resolveBatch = async (start: number, end: number) => {
    const batch = proposals.slice(start, end),
      films = await resolver(
        batch.map(({ title, year, director }) => ({ title, year, director })),
        budget,
      );
    for (const [offset, proposal] of batch.entries()) {
      const index = start + offset,
        film = films[offset];
      if (!film) {
        unresolved.push({
          index,
          title: proposal.title,
          year: proposal.year,
          director: proposal.director,
        });
        continue;
      }
      if (excluded.has(film.id)) {
        resolvedExcluded.push(film.id);
        excludedIndexes.push(index);
        continue;
      }
      if (ids.has(film.id)) {
        duplicateIds.push(film.id);
        duplicateIndexes.push(index);
        continue;
      }
      if (accepted.length < 12) {
        ids.add(film.id);
        accepted.push({ film, proposal });
      }
    }
  };
  // The visible result is exactly the twelve films the curator returned. Every
  // identity must be verified; unresolved, excluded, or duplicate rows fail the
  // whole run instead of being hidden behind generated fallback candidates.
  await resolveBatch(0, proposals.length);
  const intendedAnchors = new Set(
    output.recommendations.flatMap((proposal) => proposal.anchorIds),
  );
  const resolvedAnchors = new Set(
    accepted.flatMap((item) => item.proposal.anchorIds),
  );
  const missingAnchorIds = [...intendedAnchors].filter(
    (id) => !resolvedAnchors.has(id),
  );
  const invalidIndexes = [
    ...new Set([
      ...unresolved.map((item) => item.index),
      ...duplicateIndexes,
      ...excludedIndexes,
    ]),
  ].sort((a, b) => a - b);
  if (accepted.length !== 12 || missingAnchorIds.length)
    throw new CuratorIdentityError({
      unresolved,
      duplicateIds: [...new Set(duplicateIds)],
      excludedIds: [...new Set(resolvedExcluded)],
      duplicateIndexes,
      excludedIndexes,
      invalidIndexes,
      missingAnchorIds,
    });
  return {
    lens: output.lens,
    description: output.description,
    recommendations: accepted.map(({ film, proposal }) => ({
      film,
      anchorIds: proposal.anchorIds,
      connection: proposal.connection,
      evidenceIds: proposal.evidenceIds,
      attribution: proposal.attribution,
    })),
  };
}
