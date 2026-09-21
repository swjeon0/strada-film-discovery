import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("publish_knowledge", ROOT / "scripts/publish-knowledge.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fixture(source_id="new-source", url="https://archive.org/film/new"):
    return {
        "id": source_id,
        "url": url,
        "title": "Source",
        "author": None,
        "publisher": "Archive",
        "type": "criticism",
        "language": "en",
        "publishedAt": None,
        "checkedAt": "2026-09-20T00:00:00Z",
        "access": "full_page",
        "rights": {"mode": "restricted_excerpt", "licenseUrl": None, "note": "Test."},
        "verification": {"method": "http_fetch", "locator": "body", "note": "Test."},
        "films": [{"key": "film", "title": "Film", "year": 2000, "director": "Director", "aliases": [], "externalIds": []}],
        "passages": [{"id": "p1", "text": "Exact words.", "locator": "body"}],
        "observations": [{"id": "o1", "summary": "A reading.", "summaryKo": None, "boundary": "Limited.", "filmKeys": ["film"], "subjects": ["form"], "kind": "film_reading", "passageIds": ["p1"]}],
    }


class PublicationTests(unittest.TestCase):
    def test_requires_successful_validation_report_with_exact_counts(self):
        row = fixture()
        report = {"status": "validated", "requested": 1, "publishedCandidates": 1}
        self.assertEqual(MODULE.validate_publication([row], report, [])[0]["id"], row["id"])
        with self.assertRaisesRegex(ValueError, "successful automatic validation"):
            MODULE.validate_publication([row], {"status": "failed"}, [])
        with self.assertRaisesRegex(ValueError, "counts must exactly match"):
            MODULE.validate_publication([row], {**report, "publishedCandidates": 2}, [])

    def test_rejects_published_ids_urls_and_abstract_only_academic(self):
        row = fixture()
        report = {"status": "validated", "requested": 1, "publishedCandidates": 1}
        with self.assertRaisesRegex(ValueError, "already published"):
            MODULE.validate_publication([row], report, [fixture(row["id"], "https://other.org/x")])
        with self.assertRaisesRegex(ValueError, "already published or repeated"):
            MODULE.validate_publication([row], report, [fixture("old-source", row["url"] + "?utm_source=x")])
        academic = fixture("academic-source", "https://archive.org/film/paper")
        academic["type"] = "academic"
        academic["access"] = "abstract"
        with self.assertRaisesRegex(ValueError, "full text"):
            MODULE.validate_publication([academic], report, [])


if __name__ == "__main__":
    unittest.main()
