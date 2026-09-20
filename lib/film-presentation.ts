import { safePoster, type Film } from "./domain";

/** Detail lookups enrich film identity without swapping the artwork a person chose. */
export function mergeFilmPresentation(selected: Film, details: Film): Film {
  const titleKo = details.titleKo || selected.titleKo;
  return {
    ...details,
    poster: safePoster(selected.poster) || safePoster(details.poster),
    titleKo,
    titleKoSource:
      details.titleKoSource ||
      selected.titleKoSource ||
      (titleKo && selected.id.startsWith("tmdb:")
        ? `https://www.themoviedb.org/movie/${selected.id.slice(5)}`
        : undefined),
  };
}

/** Server responses remain authoritative for data; poster choice follows the selected ID. */
export function retainSelectedPosters(films: Film[], selected: Film[]): Film[] {
  const chosen = new Map(selected.map((f) => [f.id, f]));
  return films.map((f) => {
    const previous = chosen.get(f.id);
    return previous ? mergeFilmPresentation(previous, f) : f;
  });
}
