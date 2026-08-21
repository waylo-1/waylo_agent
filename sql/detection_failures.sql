-- Waylo: detection_failures table
-- Stores screenshots + step metadata for every case where all on-device
-- detection layers (L0/L1/L2) missed and the app fell back to vision.
-- This data becomes labelled training material for the future YOLO model.
--
-- Run this in the Supabase SQL editor (dashboard) once.

CREATE TABLE detection_failures (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_description TEXT,
  step_number INTEGER,
  find_description TEXT NOT NULL,
  element_type TEXT,
  screen_region TEXT,
  visual_description TEXT,
  target_package TEXT,
  layer_reached INTEGER,
  screenshot_base64 TEXT NOT NULL,
  screen_width INTEGER,
  screen_height INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  reviewed BOOLEAN DEFAULT false,
  yolo_label_exported BOOLEAN DEFAULT false
);

-- Index for querying by app package (useful for retraining per-app)
CREATE INDEX idx_failures_target_package ON detection_failures(target_package);

-- Index for querying unreviewed failures (for the YOLO export pipeline later)
CREATE INDEX idx_failures_unreviewed ON detection_failures(reviewed) WHERE reviewed = false;
