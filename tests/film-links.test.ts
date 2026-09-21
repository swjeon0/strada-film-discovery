import test from "node:test";
import assert from "node:assert/strict";
import { letterboxdLink } from "../lib/film-links";

test("Letterboxd links use the documented TMDB redirect without guessing title slugs", () => {
  assert.deepEqual(letterboxdLink({ id: "tmdb:414", title: "Batman Forever", year: 1995 }), {
    url: "https://letterboxd.com/tmdb/414/",
    direct: true,
  });
});

test("unresolved film identities use a title/year search and cannot inject a URL", () => {
  const film = { id: "local-film", title: "A / Film? #one", year: 1960 };
  const link = letterboxdLink(film);
  assert.equal(link.direct, false);
  assert.equal(new URL(link.url).host, "letterboxd.com");
  assert.equal(decodeURIComponent(new URL(link.url).pathname), `/search/films/${film.title} 1960/`);
  assert.equal(new URL(link.url).search, "");
  assert.equal(new URL(link.url).hash, "");
  assert.equal(letterboxdLink({ ...film, id: "tmdb:414/../../elsewhere" }).direct, false);
});
