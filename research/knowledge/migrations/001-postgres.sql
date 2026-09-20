-- PostgreSQL adapter schema; prepared for migration, not a live deployed database.
-- Same source/version/observation IDs as SQLite and portable serving artifacts.
BEGIN;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  canonical_url TEXT NOT NULL UNIQUE,
  current_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  publisher TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('criticism','academic','programme','festival')),
  language TEXT NOT NULL,
  published_at TEXT,
  checked_at TEXT NOT NULL,
  access TEXT NOT NULL CHECK(access IN ('full_page','abstract','metadata_only')),
  rights_mode TEXT NOT NULL CHECK(rights_mode IN ('restricted_excerpt','open_license','noncommercial','metadata_only')),
  license_url TEXT,
  rights_note TEXT NOT NULL,
  verification_method TEXT NOT NULL CHECK(verification_method IN ('web_open','http_fetch')),
  verification_locator TEXT NOT NULL,
  verification_note TEXT NOT NULL,
  review_status TEXT NOT NULL CHECK(review_status = 'agent_reviewed'),
  original_record_json JSONB NOT NULL,
  parser_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_id,content_hash)
);
CREATE TABLE IF NOT EXISTS film_entities (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  year INTEGER NOT NULL CHECK(year >= 1870 AND year <= 2200),
  director TEXT NOT NULL,
  director_normalized TEXT NOT NULL,
  external_ids_json JSONB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(title_normalized,year,director_normalized)
);
CREATE TABLE IF NOT EXISTS aliases (
  film_key TEXT NOT NULL REFERENCES film_entities(key),
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  alias_type TEXT NOT NULL CHECK(alias_type IN ('title','record_key')),
  year INTEGER NOT NULL,
  director_normalized TEXT NOT NULL,
  PRIMARY KEY(alias_normalized,year,director_normalized,alias_type)
);
CREATE TABLE IF NOT EXISTS document_films (
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  film_key TEXT NOT NULL REFERENCES film_entities(key),
  source_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(version_id,source_key)
);
CREATE TABLE IF NOT EXISTS passages (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  local_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  exact_quote TEXT NOT NULL,
  locator TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  match_status TEXT NOT NULL DEFAULT 'not_locally_verified' CHECK(match_status IN ('not_locally_verified','exact_match')),
  UNIQUE(version_id,local_id)
);
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  local_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  summary_ko TEXT,
  boundary TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('film_reading','comparison','contrast','influence','co_programming','historical_context','incidental_mention')),
  subjects_json JSONB NOT NULL,
  review_status TEXT NOT NULL CHECK(review_status = 'agent_reviewed'),
  UNIQUE(version_id,local_id)
);
CREATE TABLE IF NOT EXISTS observation_participants (
  observation_id TEXT NOT NULL REFERENCES observations(id),
  film_key TEXT NOT NULL REFERENCES film_entities(key),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(observation_id,film_key)
);
CREATE TABLE IF NOT EXISTS evidence_links (
  observation_id TEXT NOT NULL REFERENCES observations(id),
  passage_id TEXT NOT NULL REFERENCES passages(id),
  support_scope TEXT NOT NULL DEFAULT 'audit_anchor_not_full_entailment',
  PRIMARY KEY(observation_id,passage_id)
);
CREATE TABLE IF NOT EXISTS observation_embeddings (
  observation_id TEXT NOT NULL REFERENCES observations(id),
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions > 0),
  input_hash TEXT NOT NULL,
  embedding_json JSONB NOT NULL,
  generated_at TEXT NOT NULL,
  imported_at TEXT,
  PRIMARY KEY(observation_id,model,dimensions,input_hash)
);
CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  actor_type TEXT NOT NULL CHECK(actor_type IN ('agent','human')),
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('agent_reviewed','human_approved','needs_review','rejected')),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(actor_type = 'human' OR status != 'human_approved')
);
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id TEXT PRIMARY KEY,
  input_path TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  mode TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','completed_with_errors')),
  checkpoint INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(input_path,input_hash,mode,parser_version)
);
CREATE TABLE IF NOT EXISTS ingestion_items (
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(id),
  item_index INTEGER NOT NULL,
  record_id TEXT,
  version_id TEXT REFERENCES document_versions(id),
  input_record_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('completed','quarantined','filtered')),
  error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(job_id,item_index)
);
CREATE TABLE IF NOT EXISTS quarantine_errors (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES ingestion_jobs(id),
  item_index INTEGER NOT NULL,
  record_id TEXT,
  input_record_hash TEXT NOT NULL,
  error TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id,item_index)
);
CREATE TABLE IF NOT EXISTS curation_cases (
  id TEXT PRIMARY KEY,
  input_json JSONB NOT NULL,
  recommendation_json JSONB NOT NULL,
  corpus_version TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL CHECK(elapsed_ms >= 0),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES curation_cases(id),
  compared_case_id TEXT REFERENCES curation_cases(id),
  judge_type TEXT NOT NULL CHECK(judge_type IN ('human','model_proxy')),
  judge_id TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  preference TEXT CHECK(preference IN ('case','compared','tie')),
  scores_json JSONB NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS versions_by_source ON document_versions(source_id,created_at);
CREATE INDEX IF NOT EXISTS versions_by_rights ON document_versions(rights_mode,access);
CREATE INDEX IF NOT EXISTS aliases_by_entity ON aliases(film_key,alias_type);
CREATE INDEX IF NOT EXISTS document_films_by_entity ON document_films(film_key,version_id);
CREATE INDEX IF NOT EXISTS passages_by_version ON passages(version_id,ordinal);
CREATE INDEX IF NOT EXISTS observations_by_version ON observations(version_id,kind);
CREATE INDEX IF NOT EXISTS participants_by_entity ON observation_participants(film_key,observation_id);
CREATE INDEX IF NOT EXISTS evidence_by_passage ON evidence_links(passage_id,observation_id);
CREATE INDEX IF NOT EXISTS embeddings_by_input ON observation_embeddings(model,dimensions,input_hash);
CREATE INDEX IF NOT EXISTS reviews_by_version ON review_events(version_id,created_at);
CREATE INDEX IF NOT EXISTS jobs_by_status ON ingestion_jobs(status,updated_at);
CREATE INDEX IF NOT EXISTS judgments_by_case ON judgments(case_id,judge_type);


CREATE OR REPLACE FUNCTION reject_document_version_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'document versions are immutable';
END; $$;
DROP TRIGGER IF EXISTS immutable_document_versions ON document_versions;
CREATE TRIGGER immutable_document_versions BEFORE UPDATE ON document_versions
FOR EACH ROW EXECUTE FUNCTION reject_document_version_update();

CREATE OR REPLACE FUNCTION require_academic_full_text() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.source_type = 'academic' AND NEW.access != 'full_page' THEN
    RAISE EXCEPTION 'academic admission requires accessed full text';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS academic_full_text_admission ON document_versions;
CREATE TRIGGER academic_full_text_admission BEFORE INSERT ON document_versions
FOR EACH ROW EXECUTE FUNCTION require_academic_full_text();
COMMIT;
