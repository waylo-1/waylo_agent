-- Semantic plan cache for Waylo Desktop.
-- Run this in the Supabase SQL editor. Additive only — touches no existing tables.

CREATE EXTENSION IF NOT EXISTS vector;

-- Plan cache: full step plans keyed by a task-text embedding (Titan v1 = 1536 dims).
CREATE TABLE IF NOT EXISTS plan_cache (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name       text NOT NULL,
  task_text      text NOT NULL,
  task_embedding vector(1536) NOT NULL,
  step_plan      jsonb NOT NULL,
  hit_count      integer DEFAULT 1,
  created_at     timestamptz DEFAULT now(),
  last_hit_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plan_cache_embedding_idx
  ON plan_cache USING ivfflat (task_embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS plan_cache_app_idx ON plan_cache(app_name);

-- Similarity search RPC used by semanticPlanCache.js.
CREATE OR REPLACE FUNCTION match_plan_cache(
  query_embedding vector(1536),
  app_name_filter text,
  similarity_threshold float,
  match_count int
) RETURNS TABLE (
  id uuid, step_plan jsonb, hit_count int, similarity float
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT pc.id, pc.step_plan, pc.hit_count,
         1 - (pc.task_embedding <=> query_embedding) AS similarity
  FROM plan_cache pc
  WHERE pc.app_name = app_name_filter
    AND 1 - (pc.task_embedding <=> query_embedding) > similarity_threshold
  ORDER BY pc.task_embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- NOTE: new tables have RLS disabled by default, so the anon key the backend
-- already uses can read/write this cache. If you later enable RLS on plan_cache,
-- add policies allowing the backend role to SELECT/INSERT/UPDATE, or switch the
-- backend to a service-role key.
