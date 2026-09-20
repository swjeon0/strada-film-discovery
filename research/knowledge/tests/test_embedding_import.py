"""Version/hash integrity and idempotent persistence of offline cached vectors."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from test_ingestion import ROOT, builder, record

spec = importlib.util.spec_from_file_location("import_embeddings", ROOT / "scripts/import-knowledge-embeddings.py")
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class EmbeddingImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name)
        self.inputs = self.path / "records.json"
        self.db = self.path / "corpus.sqlite"
        self.index = self.path / "index.json"
        self.cache = self.path / "embeddings.json"

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, records):
        self.inputs.write_text(json.dumps(records))
        builder.build(self.inputs, self.db, self.index)

    def make_cache(self, generated=False):
        vectors, times = {}, {}
        for document in json.loads(self.index.read_text())["documents"]:
            for observation in document["observations"]:
                hashed = importer.input_hash("test-model", 3, importer.embedding_input(observation))
                vectors[hashed] = [0.1, 0.2, 0.3]
                times[hashed] = "2026-09-20T19:00:00Z"
        data = {"model": "test-model", "dimensions": 3, "vectors": vectors}
        if generated:
            data["generatedAt"] = times
        self.cache.write_text(json.dumps(data))
        return data

    def run_import(self):
        return importer.import_embeddings(self.index, self.cache, self.db)

    def test_hash_matches_node_utf8_hash_for_bilingual_embedding_input(self):
        observation = {"summary": "Frames hold duration.", "summaryKo": "프레임은 시간을 붙든다.", "subjects": ["duration", "space"], "boundary": "No influence claim."}
        hashed = importer.input_hash("text-embedding-3-small", 256, importer.embedding_input(observation))
        # Independently computed with node:crypto createHash('sha256').update(...).
        self.assertEqual(hashed, "22f0ffb4b625b790a05e7981ca460fc1ebaa93d1d11c2a8c8cecccf0823290b7")

    def test_imports_versioned_observation_once_and_preserves_unknown_generation_time(self):
        self.build([record()])
        self.make_cache()
        first, second = self.run_import(), self.run_import()
        self.assertEqual(first["inserted"], 1)
        self.assertEqual(second["inserted"], 0)
        self.assertEqual(second["reused"], 1)
        self.assertEqual(second["activeObservationEmbeddings"], 1)
        self.assertEqual(second["networkCalls"], 0)
        with sqlite3.connect(self.db) as db:
            row = db.execute("SELECT e.observation_id,e.input_hash,e.generated_at,e.imported_at,o.version_id FROM observation_embeddings e JOIN observations o ON o.id=e.observation_id").fetchone()
        self.assertEqual(row[0], f"{row[4]}/o1")
        self.assertEqual(row[2], "unknown_legacy_cache")
        self.assertTrue(row[3].endswith("Z"))

    def test_reuses_one_cached_vector_for_distinct_source_observations(self):
        self.build([record(), record("second-source")])
        cache = self.make_cache(generated=True)
        self.assertEqual(len(cache["vectors"]), 1)
        result = self.run_import()
        self.assertEqual(result["inserted"], 2)
        self.assertEqual(result["distinctInputHashes"], 1)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT DISTINCT generated_at FROM observation_embeddings").fetchone()[0], "2026-09-20T19:00:00Z")

    def test_changed_observation_gets_new_version_hash_and_preserves_old_vector(self):
        item = record()
        self.build([item])
        self.make_cache()
        self.run_import()
        item["observations"][0]["summary"] = "The revised observation describes duration."
        self.build([item])
        self.make_cache()
        result = self.run_import()
        self.assertEqual(result["inserted"], 1)
        self.assertEqual(result["activeObservationEmbeddings"], 1)
        self.assertEqual(result["totalHistoricalEmbeddings"], 2)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT count(DISTINCT input_hash) FROM observation_embeddings").fetchone()[0], 2)

    def test_stale_serving_version_cannot_attach_to_new_active_observation(self):
        item = record()
        self.build([item])
        old_index = self.index.read_text()
        self.make_cache()
        item["observations"][0]["summary"] = "A revised source reading."
        self.build([item])
        self.index.write_text(old_index)
        with self.assertRaisesRegex(ValueError, "not the active SQLite version"):
            self.run_import()

    def test_tampered_serving_summary_is_rejected_even_with_matching_version_id(self):
        self.build([record()])
        index = json.loads(self.index.read_text())
        index["documents"][0]["observations"][0]["summary"] = "This is not the persisted source observation."
        self.index.write_text(json.dumps(index))
        self.make_cache()
        with self.assertRaisesRegex(ValueError, "differs from persisted observation"):
            self.run_import()

    def test_partial_old_index_cannot_omit_current_active_documents(self):
        self.build([record(), record("second-source")])
        self.make_cache()
        index = json.loads(self.index.read_text())
        index["documents"].pop()
        self.index.write_text(json.dumps(index))
        with self.assertRaisesRegex(ValueError, "corpus membership"):
            self.run_import()

    def test_invalid_later_vector_rolls_back_entire_import(self):
        first, second = record(), record("second-source")
        second["observations"][0]["summary"] = "Another observation with another hash."
        self.build([first, second])
        cache = self.make_cache()
        last = list(cache["vectors"])[-1]
        cache["vectors"][last] = [0.1, float("nan"), 0.3]
        self.cache.write_text(json.dumps(cache))
        with self.assertRaisesRegex(ValueError, "invalid cached embedding"):
            self.run_import()
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM observation_embeddings").fetchone()[0], 0)

    def test_removed_document_keeps_only_historical_embedding(self):
        self.build([record()])
        self.make_cache()
        self.run_import()
        self.build([])
        result = self.run_import()
        self.assertEqual(result["inserted"], 0)
        self.assertEqual(result["activeObservationEmbeddings"], 0)
        self.assertEqual(result["totalHistoricalEmbeddings"], 1)

    def test_existing_vector_conflict_is_not_silently_overwritten(self):
        self.build([record()])
        cache = self.make_cache()
        self.run_import()
        cache["vectors"][next(iter(cache["vectors"]))] = [0.3, 0.2, 0.1]
        self.cache.write_text(json.dumps(cache))
        with self.assertRaisesRegex(ValueError, "conflicts with immutable"):
            self.run_import()


if __name__ == "__main__":
    unittest.main()
