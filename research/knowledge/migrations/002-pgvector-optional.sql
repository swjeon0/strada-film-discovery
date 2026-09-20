-- Optional future adapter. Requires pgvector installed by the database operator.
-- This migration has not been applied to a live PostgreSQL instance.
-- Keep JSON cache provenance even when vectors are indexed in PostgreSQL.
BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE observation_embeddings ADD COLUMN IF NOT EXISTS embedding vector(256);
CREATE INDEX IF NOT EXISTS observation_embeddings_cosine_256
ON observation_embeddings USING hnsw (embedding vector_cosine_ops)
WHERE dimensions = 256;
COMMIT;
