import assert from "node:assert/strict";
import test from "node:test";
import {
  auditRecord,
  extractAuditText,
  normalizeQuote,
  quoteCheck,
  sourceUrlAllowed,
} from "../scripts/audit-knowledge-sources";

test("source audit preserves visible inline prose while excluding script and navigation text", () => {
  const text = extractAuditText(
    "<html><head><title>Other</title></head><body><nav>Fake quotation</nav><article><p>A <em>film</em> &amp; its audience.</p><script>invented quote</script><p hidden>Hidden words</p><p>Next paragraph.</p></article></body></html>",
  );
  assert.equal(text, "A film & its audience.\n\nNext paragraph.");
  assert.equal(
    quoteCheck(text, { id: "p", text: "Fake quotation", locator: "body" })
      .status,
    "quote_missing",
  );
});
test("quote matching tolerates typography and PDF line hyphenation but not missing or reordered words", () => {
  const text = "The author’s long–take\ninter-\npretation matters.";
  const result = quoteCheck(text, {
    id: "p",
    text: "author's long-take interpretation",
    locator: "body",
  });
  assert.equal(result.status, "matched");
  assert.equal(result.offsetBasis, "normalized_text");
  assert.equal(normalizeQuote("ﬁlm\u00a0“seeing”"), 'film "seeing"');
  assert.equal(
    quoteCheck(text, { id: "p", text: "The author matters", locator: "body" })
      .status,
    "quote_missing",
  );
  assert.equal(
    quoteCheck(text, {
      id: "p",
      text: "interpretation long-take",
      locator: "body",
    }).status,
    "quote_missing",
  );
});
test("source audit reads public transcripts explicitly linked from a collapsed section", () => {
  const text = extractAuditText(
    '<article><a href="#transcript-72">Read transcript</a><div id="transcript-72" aria-hidden="true"><p>Public spoken words.</p></div><div id="unlinked" aria-hidden="true">Private interface text</div></article>',
  );
  assert.equal(
    quoteCheck(text, {
      id: "p",
      text: "Public spoken words.",
      locator: "transcript",
    }).status,
    "matched",
  );
  assert.equal(text.includes("Private interface text"), false);
});
test("a source URL fragment locates its public collapsed transcript without revealing other hidden content", () => {
  const text = extractAuditText(
    '<article><a href="/calendar/film#transcription-72">Read transcript</a><div id="transcription-72" aria-hidden="true"><p>Public spoken words.</p></div><div id="unlinked" aria-hidden="true">Private interface text</div></article>',
    "transcription-72",
  );
  assert.equal(
    quoteCheck(text, {
      id: "p",
      text: "Public spoken words.",
      locator: "transcript",
    }).status,
    "matched",
  );
  assert.equal(text.includes("Private interface text"), false);
});
test("network, blocking, and PDF conversion failures never become quote-missing conclusions", async () => {
  const record = {
    id: "doc",
    url: "https://publisher.org/page",
    passages: [{ id: "p", text: "Actual words.", locator: "paragraph" }],
  };
  for (const status of [
    "network_error",
    "blocked",
    "pdf_not_checked",
  ] as const) {
    const result = await auditRecord(record, async (url) => ({
      url,
      status,
      httpStatus: null,
      checkedAt: "2026-09-20T00:00:00Z",
      contentHash: null,
    }));
    assert.equal(result.status, status);
    assert.equal(result.quotes[0].status, "not_checked");
  }
  const missing = await auditRecord(record, async (url) => ({
    url,
    status: "readable",
    httpStatus: 200,
    checkedAt: "2026-09-20T00:00:00Z",
    contentHash: "hash",
    text: "Different words.",
  }));
  assert.equal(missing.status, "quote_missing");
});
test("audit uses an explicitly supplied full text URL and rejects unsafe URL shapes", async () => {
  const record = {
    id: "doc",
    url: "https://publisher.org/page",
    verification: { textUrl: "https://publisher.org/download.pdf" },
    passages: [{ id: "p", text: "Actual words.", locator: "page 2" }],
  };
  const result = await auditRecord(record, async (url) => ({
    url,
    status: "readable",
    httpStatus: 200,
    checkedAt: "2026-09-20T00:00:00Z",
    contentHash: "hash",
    text: "Actual words.",
  }));
  assert.equal(result.checkedUrl, record.verification.textUrl);
  assert.equal(result.quotes[0].offset, 0);
  for (const url of [
    "http://publisher.org/page",
    "https://127.0.0.1/x",
    "https://user:pass@publisher.org/x",
    "https://publisher.org:999/x",
    "https://localhost/x",
    "https://app.internal/x",
  ])
    assert.equal(sourceUrlAllowed(url), false);
  assert.equal(sourceUrlAllowed(record.url), true);
});
