import type { Film } from "./domain";

/** Letterboxd documents the TMDB redirect; never guess a title slug. */
export function letterboxdLink(film: Pick<Film, "id" | "title" | "year">) {
  const tmdb = /^tmdb:([1-9]\d*)$/.exec(film.id);
  return tmdb
    ? { url: `https://letterboxd.com/tmdb/${tmdb[1]}/`, direct: true }
    : {
        url: `https://letterboxd.com/search/films/${encodeURIComponent(`${film.title} ${film.year}`)}/`,
        direct: false,
      };
}
