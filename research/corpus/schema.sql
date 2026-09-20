PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('programme','criticism','scholarship')),
  title TEXT NOT NULL,
  author_or_curator TEXT,
  publisher TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  published_at TEXT,
  rights_status TEXT NOT NULL,
  access_status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  fetch_status TEXT NOT NULL,
  raw_locator TEXT,
  UNIQUE(document_id, content_hash)
);

CREATE TABLE IF NOT EXISTS extraction_runs (
  id INTEGER PRIMARY KEY,
  extractor TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_usd REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS passages (
  id INTEGER PRIMARY KEY,
  document_version_id INTEGER NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  locator TEXT NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  language TEXT,
  char_start INTEGER,
  char_end INTEGER,
  UNIQUE(document_version_id, ordinal),
  UNIQUE(document_version_id, text_hash)
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('film','person','institution','concept','programme','other')),
  canonical_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  year INTEGER,
  external_id TEXT,
  UNIQUE(entity_type, canonical_key)
);

CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY,
  passage_id INTEGER NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mention_role TEXT NOT NULL,
  surface_form TEXT,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extraction_run_id INTEGER REFERENCES extraction_runs(id),
  UNIQUE(passage_id, entity_id, mention_role)
);

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  passage_id INTEGER NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  extraction_run_id INTEGER REFERENCES extraction_runs(id),
  speaker TEXT,
  claim_type TEXT NOT NULL,
  polarity TEXT NOT NULL CHECK (polarity IN ('supports','qualifies','rejects','describes')),
  scope TEXT NOT NULL,
  summary TEXT NOT NULL,
  context_boundary TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  review_status TEXT NOT NULL CHECK (review_status IN ('unreviewed','accepted','rejected','needs_review')),
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS claim_participants (
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  participant_role TEXT NOT NULL,
  PRIMARY KEY (claim_id, entity_id, participant_role)
);

CREATE TABLE IF NOT EXISTS claim_operations (
  claim_id INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  PRIMARY KEY (claim_id, operation)
);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY,
  claim_id INTEGER REFERENCES claims(id) ON DELETE SET NULL,
  relation_type TEXT NOT NULL,
  polarity TEXT NOT NULL CHECK (polarity IN ('supports','qualifies','rejects','describes')),
  scope TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  review_status TEXT NOT NULL CHECK (review_status IN ('unreviewed','accepted','rejected','needs_review'))
);

CREATE TABLE IF NOT EXISTS relation_participants (
  relation_id INTEGER NOT NULL REFERENCES relations(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  participant_role TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (relation_id, entity_id, participant_role)
);

CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('document','passage','mention','claim','relation')),
  object_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(object_type, object_id, reason)
);

CREATE TABLE IF NOT EXISTS recommendation_runs (
  id TEXT PRIMARY KEY,
  condition TEXT NOT NULL,
  seed_json TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recommendation_judgments (
  id INTEGER PRIMARY KEY,
  run_a_id TEXT NOT NULL REFERENCES recommendation_runs(id),
  run_b_id TEXT NOT NULL REFERENCES recommendation_runs(id),
  judge_type TEXT NOT NULL,
  judge_model TEXT,
  preferred TEXT NOT NULL CHECK (preferred IN ('a','b','tie')),
  scores_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS passages_by_document ON passages(document_version_id, ordinal);
CREATE INDEX IF NOT EXISTS mentions_by_entity ON mentions(entity_id, passage_id);
CREATE INDEX IF NOT EXISTS claims_by_type ON claims(claim_type, polarity, review_status);
CREATE INDEX IF NOT EXISTS claim_participants_by_entity ON claim_participants(entity_id, claim_id);
CREATE INDEX IF NOT EXISTS claim_operations_by_operation ON claim_operations(operation, claim_id);
CREATE INDEX IF NOT EXISTS relations_by_type ON relations(relation_type, polarity, review_status);
CREATE INDEX IF NOT EXISTS relation_participants_by_entity ON relation_participants(entity_id, relation_id);
CREATE INDEX IF NOT EXISTS review_queue_by_status ON review_queue(status, priority DESC);
