-- Step label cache for Waylo Desktop.
-- Run in the Supabase SQL editor. Additive — touches no existing tables.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS step_label_cache (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name         text NOT NULL,
  step_description text NOT NULL,
  step_embedding   vector(1536) NOT NULL,
  ax_label         text NOT NULL,
  hit_count        integer DEFAULT 1,
  created_at       timestamptz DEFAULT now(),
  last_hit_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS step_label_embedding_idx
  ON step_label_cache USING ivfflat (step_embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS step_label_app_idx ON step_label_cache(app_name);

CREATE OR REPLACE FUNCTION match_step_label_cache(
  query_embedding vector(1536),
  app_name_filter text,
  similarity_threshold float,
  match_count int
) RETURNS TABLE (
  id uuid, ax_label text, hit_count int, similarity float
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT slc.id, slc.ax_label, slc.hit_count,
         1 - (slc.step_embedding <=> query_embedding) AS similarity
  FROM step_label_cache slc
  WHERE slc.app_name = app_name_filter
    AND 1 - (slc.step_embedding <=> query_embedding) > similarity_threshold
  ORDER BY slc.step_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
