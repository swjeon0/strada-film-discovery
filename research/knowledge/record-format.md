# STRADA source record v1

Each `records/*.json` file is an array of automatically validated records. A record is a bounded reading of a document, not a claim to have ingested its full text.

```json
{
  "id": "publisher-short-stable-slug",
  "url": "https://publisher.example/article",
  "title": "Actual document title",
  "author": "Author or null",
  "publisher": "Publisher",
  "type": "criticism",
  "language": "en",
  "publishedAt": null,
  "checkedAt": "2026-09-20T00:00:00.000Z",
  "access": "full_page",
  "rights": {
    "mode": "restricted_excerpt",
    "licenseUrl": null,
    "note": "Publicly readable; redistribution permission not established. Only a short quotation and original annotations retained."
  },
  "verification": {
    "method": "web_open",
    "locator": "Article body, paragraph beginning ...",
    "note": "Read original publisher page."
  },
  "films": [
    {
      "key": "late-spring-1949-ozu",
      "title": "Late Spring",
      "year": 1949,
      "director": "Yasujiro Ozu",
      "aliases": ["Banshun", "만춘"],
      "externalIds": []
    }
  ],
  "passages": [
    {
      "id": "p1",
      "text": "An exact short quotation, with at most 25 quoted words across the whole document.",
      "locator": "Article body, paragraph beginning ..."
    }
  ],
  "observations": [
    {
      "id": "o1",
      "summary": "An original precise paraphrase of what the author says, not new film comparison.",
      "summaryKo": "정확한 한국어 요약",
      "boundary": "What this document does not establish; prevent overclaiming.",
      "filmKeys": ["late-spring-1949-ozu"],
      "subjects": ["domestic space", "elliptical narration"],
      "kind": "film_reading",
      "passageIds": ["p1"]
    }
  ]
}
```

- `type`: `criticism | academic | programme | festival`.
- `access`: `full_page | abstract | metadata_only`. **Academic sources must be `full_page` after actually reading their full-text page or PDF. Abstract-only papers are rejected, including historical records accidentally reintroduced.** Record the accessed PDF in `verification.textUrl` when the public landing-page URL differs.
- `rights.mode`: `restricted_excerpt | open_license | noncommercial | metadata_only`. Never infer open or noncommercial licensing from free access.
- `verification.method`: `web_open | http_fetch`. The ingestion audit adds hashes and byte/character matches; never invent these.
- `observations.kind`: `film_reading | comparison | contrast | influence | co_programming | historical_context | incidental_mention`. Mere co-mention is not comparison or influence. A programme is one many-participant observation, not all film pairs.
- `filmKeys` resolve within this document's `films`; only attach films actually discussed in that observation. Provide accurate year/director. Aliases must be actual titles, not generated translations. Leave external IDs empty if not verified.
- `passageIds` resolve within this document. The quote is an audit anchor. The paraphrase may summarize the opened paragraph or article, but is never an exact quotation and does not assert that the small quoted span entails all of it.
- At least one informative exact passage and one observation per accessible source. Keep total quote words per source at most 25 and total derived prose under 160 words. No inaccessible full texts, fabricated locators, or paywall bypass.
- Admission records the automatic checks in the collection validation report; the serving schema has no person-review field.
