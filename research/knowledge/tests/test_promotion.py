import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("promote_knowledge", ROOT / "scripts/promote-knowledge.py")
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
        "reviewStatus": "agent_reviewed",
        "films": [{"key": "film", "title": "Film", "year": 2000, "director": "Director", "aliases": [], "externalIds": []}],
        "passages": [{"id": "p1", "text": "Exact words.", "locator": "body"}],
        "observations": [{"id": "o1", "summary": "A reading.", "summaryKo": None, "boundary": "Limited.", "filmKeys": ["film"], "subjects": ["form"], "kind": "film_reading", "passageIds": ["p1"]}],
    }


class PromotionTests(unittest.TestCase):
    def test_requires_exactly_matching_successful_audit(self):
        row = fixture()
        audit = {"documents": [{"documentId": row["id"], "status": "matched"}]}
        self.assertEqual(MODULE.validate_promotion([row], audit, [])[0]["id"], row["id"])
        with self.assertRaisesRegex(ValueError, "did not pass"):
            MODULE.validate_promotion([row], {"documents": [{"documentId": row["id"], "status": "quote_missing"}]}, [])
        with self.assertRaisesRegex(ValueError, "exactly match"):
            MODULE.validate_promotion([row], {"documents": []}, [])

    def test_rejects_published_ids_urls_and_abstract_only_academic(self):
        row = fixture()
        audit = {"documents": [{"documentId": row["id"], "status": "matched"}]}
        with self.assertRaisesRegex(ValueError, "already published"):
            MODULE.validate_promotion([row], audit, [fixture(row["id"], "https://other.org/x")])
        with self.assertRaisesRegex(ValueError, "already published or repeated"):
            MODULE.validate_promotion([row], audit, [fixture("old-source", row["url"] + "?utm_source=x")])
        academic = fixture("academic-source", "https://archive.org/film/paper")
        academic["type"] = "academic"
        academic["access"] = "abstract"
        with self.assertRaisesRegex(ValueError, "full text"):
            MODULE.validate_promotion([academic], {"documents": [{"documentId": academic["id"], "status": "matched"}]}, [])


if __name__ == "__main__":
    unittest.main()
