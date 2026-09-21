"""Offline invariants for versioned records, identity reconciliation and recovery."""
import copy
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("build_knowledge", ROOT / "scripts/build-knowledge.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def record(source_id="criterion-late-spring"):
    return {
        "id": source_id, "url": f"https://example.org/{source_id}", "title": "A reading of Late Spring",
        "author": "A Critic", "publisher": "Test Publisher", "type": "criticism", "language": "en",
        "publishedAt": None, "checkedAt": "2026-09-20T00:00:00Z", "access": "full_page",
        "rights": {"mode": "restricted_excerpt", "licenseUrl": None, "note": "Permission not established."},
        "verification": {"method": "web_open", "locator": "Paragraph 2", "note": "Original page read."},
        "films": [{"key": "late-spring-1949-ozu", "title": "Late Spring", "year": 1949, "director": "Yasujiro Ozu", "aliases": ["Banshun", "만춘"], "externalIds": []}],
        "passages": [{"id": "p1", "text": "A quiet view of domestic space.", "locator": "Paragraph 2"}],
        "observations": [{"id": "o1", "summary": "The author discusses domestic space.", "summaryKo": "저자는 가정의 공간을 논한다.", "boundary": "No influence claim.", "filmKeys": ["late-spring-1949-ozu"], "subjects": ["domestic space"], "kind": "film_reading", "passageIds": ["p1"]}],
    }


class IngestionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)
        self.inputs = self.path / "records"
        self.inputs.mkdir()
        self.db = self.path / "corpus.sqlite"
        self.out = self.path / "serving-index.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, records, name="test.json"):
        (self.inputs / name).write_text(json.dumps(records))

    def build(self, commercial=False):
        return builder.build(self.inputs, self.db, self.out, commercial)

    def test_repeated_build_is_idempotent_and_evidence_stays_separate(self):
        self.write([record()])
        first = self.build()
        first_export = self.out.read_bytes()
        second = self.build()
        self.assertEqual(first["databaseCounts"], second["databaseCounts"])
        self.assertEqual(first["corpusVersion"], second["corpusVersion"])
        self.assertEqual(first_export, self.out.read_bytes())
        self.assertTrue(second["records"][0]["resumed"])
        self.assertEqual(second["sqliteIntegrity"], "ok")
        self.assertEqual(second["foreignKeyErrors"], 0)
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT exact_quote FROM passages").fetchone()[0], record()["passages"][0]["text"])
            self.assertEqual(db.execute("SELECT summary FROM observations").fetchone()[0], record()["observations"][0]["summary"])
            self.assertEqual(db.execute("SELECT match_status FROM passages").fetchone()[0], "not_locally_verified")
            self.assertEqual(db.execute("SELECT count(*) FROM judgments").fetchone()[0], 0)

    def test_new_content_keeps_immutable_previous_version(self):
        original = record()
        self.write([original])
        first = self.build()
        original["observations"][0]["summary"] = "A revised, more precise reading of space."
        self.write([original])
        second = self.build()
        self.assertEqual(second["databaseCounts"]["sources"], 1)
        self.assertEqual(second["databaseCounts"]["document_versions"], 2)
        self.assertNotEqual(first["corpusVersion"], second["corpusVersion"])
        self.assertEqual(second["stats"]["versions"], 1)
        with closing(sqlite3.connect(self.db)) as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE document_versions SET title='Overwritten'")

    def test_recheck_does_not_duplicate_unchanged_content(self):
        item = record()
        self.write([item])
        first = self.build()
        item["checkedAt"] = "2026-09-21T00:00:00Z"
        self.write([item])
        second = self.build()
        self.assertEqual(second["databaseCounts"]["document_versions"], 1)
        self.assertEqual(first["corpusVersion"], second["corpusVersion"])

    def test_aliases_deduplicate_across_documents_and_keep_original_keys(self):
        a, b = record(), record("another-late-spring")
        b["films"][0].update({"key": "banshun", "title": "Banshun", "aliases": ["Late Spring"]})
        b["observations"][0]["filmKeys"] = ["banshun"]
        self.write([a, b])
        result = self.build()
        self.assertEqual(result["stats"]["films"], 1)
        output = json.loads(self.out.read_text())
        a, b = output["documents"]
        self.assertEqual(a["films"][0]["key"], b["films"][0]["key"])
        for item in output["documents"]:
            self.assertEqual(item["keyMappings"][item["films"][0]["sourceKey"]], item["films"][0]["key"])

    def test_wrong_director_key_is_quarantined_and_transaction_rolls_back(self):
        good, bad = record(), record("wrong-director")
        bad["films"][0]["director"] = "John Ford"
        self.write([good, bad])
        result = self.build()
        self.assertEqual(result["quarantined"], 1)
        self.assertEqual(result["databaseCounts"]["sources"], 1)
        self.assertEqual(result["databaseCounts"]["document_versions"], 1)
        self.assertEqual(result["stats"]["documents"], 1)
        self.assertIn("inconsistent identity", result["records"][1]["error"])

    def test_reused_key_cannot_silently_merge_different_title_same_year_director(self):
        good, bad = record(), record("wrong-title")
        bad["films"][0].update({"title": "Another Film", "aliases": []})
        self.write([good, bad])
        result = self.build()
        self.assertEqual(result["quarantined"], 1)
        self.assertIn("inconsistent title", result["records"][1]["error"])

    def test_ambiguous_alias_bridging_two_entities_is_quarantined(self):
        first, second, bridge = record(), record("second-film"), record("ambiguous-bridge")
        second["films"][0].update({"key": "another-film", "title": "Another Film", "aliases": []})
        second["observations"][0]["filmKeys"] = ["another-film"]
        bridge["films"][0]["aliases"].append("Another Film")
        self.write([first, second, bridge])
        result = self.build()
        self.assertEqual(result["quarantined"], 1)
        self.assertIn("ambiguous film aliases", result["records"][2]["error"])

    def test_aliases_cannot_create_self_comparison(self):
        item = record()
        alias = copy.deepcopy(item["films"][0])
        alias.update({"key": "banshun", "title": "Banshun", "aliases": ["Late Spring"]})
        item["films"].append(alias)
        item["observations"][0].update({"kind": "comparison", "filmKeys": ["late-spring-1949-ozu", "banshun"]})
        self.write([item])
        result = self.build()
        self.assertEqual(result["quarantined"], 1)
        self.assertIn("duplicate canonical film", result["records"][0]["error"])

    def test_missing_references_long_quotes_and_years_are_rejected(self):
        cases = []
        missing = record("missing-reference")
        missing["observations"][0]["passageIds"] = ["missing"]
        cases.append(missing)
        long = record("long-quote")
        long["passages"][0]["text"] = " ".join(["word"] * 26)
        cases.append(long)
        year = record("impossible-year")
        year["films"][0]["year"] = 1400
        cases.append(year)
        self.write(cases)
        result = self.build()
        self.assertEqual(result["quarantined"], 3)
        self.assertEqual(result["databaseCounts"]["sources"], 0)

    def test_no_invented_license(self):
        license = record("license-without-url")
        license["rights"]["mode"] = "open_license"
        self.write([license])
        self.assertEqual(self.build()["quarantined"], 1)

    def test_commercial_filter_is_conservative_and_never_relabels(self):
        restricted = record("restricted")
        noncommercial = record("noncommercial")
        noncommercial["rights"].update({"mode": "noncommercial", "licenseUrl": "https://creativecommons.org/licenses/by-nc/4.0/"})
        licensed = record("licensed")
        licensed["rights"].update({"mode": "open_license", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/"})
        self.write([restricted, noncommercial, licensed])
        all_sources = self.build()
        filtered = self.build(commercial=True)
        self.assertEqual(all_sources["stats"]["documents"], 3)
        self.assertEqual(filtered["stats"]["documents"], 1)
        self.assertEqual(json.loads(self.out.read_text())["documents"][0]["id"], "licensed")

    def test_co_programming_is_one_many_participant_observation(self):
        item = record()
        item["films"].append({"key": "early-summer", "title": "Early Summer", "year": 1951, "director": "Yasujiro Ozu", "aliases": ["Bakushu"], "externalIds": []})
        item["observations"][0].update({"kind": "co_programming", "filmKeys": ["late-spring-1949-ozu", "early-summer"]})
        self.write([item])
        self.build()
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM observations").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM observation_participants").fetchone()[0], 2)

    def test_removed_input_is_not_exported_from_old_database(self):
        self.write([record(), record("removed-source")])
        self.build()
        self.write([record()])
        result = self.build()
        self.assertEqual(result["databaseCounts"]["sources"], 2)
        self.assertEqual(result["stats"]["documents"], 1)
        self.assertEqual(result["databaseCounts"]["active_sources"], 1)

    def test_academic_abstract_is_quarantined_and_never_served(self):
        item = record("academic-abstract")
        item.update({"type": "academic", "access": "abstract"})
        self.write([item])
        result = self.build()
        self.assertEqual(result["quarantined"], 1)
        self.assertEqual(result["stats"]["documents"], 0)
        self.assertEqual(result["databaseCounts"]["active_sources"], 0)
        self.assertIn("academic admission requires accessed full text", result["records"][0]["error"])

    def test_full_text_academic_is_admitted(self):
        item = record("academic-full-text")
        item["type"] = "academic"
        self.write([item])
        result = self.build()
        self.assertEqual(result["quarantined"], 0)
        self.assertEqual(result["stats"]["byType"]["academic"], 1)

    def test_removed_academic_is_deactivated_but_history_survives(self):
        item = record("removed-academic")
        item["type"] = "academic"
        self.write([item])
        self.build()
        self.write([])
        result = self.build()
        self.assertEqual(result["stats"]["documents"], 0)
        self.assertEqual(result["databaseCounts"]["sources"], 1)
        self.assertEqual(result["databaseCounts"]["document_versions"], 1)
        self.assertEqual(result["databaseCounts"]["active_sources"], 0)
        self.assertEqual(json.loads(self.out.read_text())["documents"], [])

    def test_historical_abstract_cannot_bypass_export_guard(self):
        item = record("legacy-abstract")
        item.update({"type": "academic", "access": "abstract"})
        # Emulate a database written under the former abstract-permitting policy.
        db = builder.connect(self.db)
        db.execute("DROP TRIGGER academic_full_text_admission")
        with db:
            version_id = builder.import_record(db, item, builder.now())
        direct_export = builder.export_index(db, [version_id], self.out, False)
        self.assertEqual(direct_export["documents"], [])
        db.close()
        self.write([])
        result = self.build()
        self.assertEqual(result["databaseCounts"]["document_versions"], 1)
        self.assertEqual(result["databaseCounts"]["active_sources"], 0)
        self.assertEqual(result["stats"]["documents"], 0)

    def test_malformed_file_is_quarantined_without_aborting_other_files(self):
        self.write([record()])
        (self.inputs / "broken.json").write_text("{broken")
        result = self.build()
        self.assertEqual(result["quarantined"], 1)
        self.assertEqual(result["stats"]["documents"], 1)

    def test_corrected_record_resumes_as_new_job(self):
        item = record()
        item["observations"][0]["passageIds"] = ["nope"]
        self.write([item])
        self.assertEqual(self.build()["quarantined"], 1)
        item["observations"][0]["passageIds"] = ["p1"]
        self.write([item])
        self.assertEqual(self.build()["stats"]["documents"], 1)
        self.assertEqual(self.build()["databaseCounts"]["document_versions"], 1)

    def test_registry_keeps_identity_stable_when_alias_document_sorts_first(self):
        self.write([record()], "z-original.json")
        self.build()
        original_key = json.loads(self.out.read_text())["films"][0]["key"]
        alias = record("alias-source")
        alias["films"][0].update({"key": "banshun", "title": "Banshun", "aliases": ["Late Spring"]})
        alias["observations"][0]["filmKeys"] = ["banshun"]
        self.write([alias], "a-new-alias.json")
        fresh_db = self.path / "rebuilt.sqlite"
        result = builder.build(self.inputs, fresh_db, self.out)
        self.assertEqual(result["stats"]["films"], 1)
        self.assertEqual(json.loads(self.out.read_text())["films"][0]["key"], original_key)

    def test_partial_publication_date_and_pdf_text_url_are_preserved(self):
        item = record()
        item["publishedAt"] = "2007-05"
        item["verification"]["textUrl"] = "https://example.org/paper.pdf"
        self.write([item])
        self.assertEqual(self.build()["quarantined"], 0)
        output = json.loads(self.out.read_text())["documents"][0]
        self.assertEqual(output["publishedAt"], "2007-05")
        self.assertEqual(output["verification"]["textUrl"], "https://example.org/paper.pdf")


if __name__ == "__main__":
    unittest.main()
