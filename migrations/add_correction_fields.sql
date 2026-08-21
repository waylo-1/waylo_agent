-- Waylo: add_correction_fields
--
-- The live Aurora PostgreSQL detection_failures table does NOT match
-- sql/detection_failures.sql (that file targets Supabase and was never
-- applied here). The live table has exactly:
--   id (bigint), step_description (text), platform (text),
--   screenshot_path (text), created_at (timestamp)
--
-- routes/failure.js (as of commit e7653a4) inserts into a much larger set
-- of columns across its three event kinds (auto_miss / user_correction /
-- auto_success) that don't exist on the live table at all. This migration
-- adds exactly those columns, all nullable, so the existing INSERT keeps
-- working. It does not touch any existing column and does not add
-- constraints or indexes.
--
-- Apply once against the live Aurora instance.

ALTER TABLE detection_failures
  ADD COLUMN IF NOT EXISTS session_id TEXT,
  ADD COLUMN IF NOT EXISTS task_description TEXT,
  ADD COLUMN IF NOT EXISTS step_number INTEGER,
  ADD COLUMN IF NOT EXISTS find_description TEXT,
  ADD COLUMN IF NOT EXISTS element_type TEXT,
  ADD COLUMN IF NOT EXISTS screen_region TEXT,
  ADD COLUMN IF NOT EXISTS visual_description TEXT,
  ADD COLUMN IF NOT EXISTS target_package TEXT,
  ADD COLUMN IF NOT EXISTS layer_reached INTEGER,
  ADD COLUMN IF NOT EXISTS screenshot_base64 TEXT,
  ADD COLUMN IF NOT EXISTS screen_width INTEGER,
  ADD COLUMN IF NOT EXISTS screen_height INTEGER,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS correction_text TEXT,
  ADD COLUMN IF NOT EXISTS corrected_target JSONB,
  ADD COLUMN IF NOT EXISTS current_package TEXT,
  ADD COLUMN IF NOT EXISTS current_activity TEXT,
  ADD COLUMN IF NOT EXISTS screenshot_hash TEXT,
  ADD COLUMN IF NOT EXISTS chosen_box JSONB;
