/**
 * POST /failure
 *
 * Records one of three event kinds into detection_failures (see
 * migrations/add_correction_fields.sql for the schema history):
 *
 *   - auto_miss (default, original behaviour): every on-device detection
 *     layer missed and we fell back to vision. screenshotBase64 is required.
 *   - user_correction: the volume-button-double-press correction flow — the
 *     user's spoken correction (correctionText) and/or the node they tapped
 *     as the actually-correct target (correctedTarget: {bounds, text,
 *     contentDescription, viewId}), plus the screen they were actually on
 *     (currentPackage/currentActivity). No screenshot required.
 *   - auto_success: an opt-in log of a successful YOLO detection as a
 *     training pair (chosenBox + screenshotHash, not a raw screenshot). No
 *     screenshot required.
 *
 * AWS schema (detection_failures, Aurora PostgreSQL): id UUID, session_id
 * TEXT NOT NULL, task_description TEXT, step_number INTEGER, find_description
 * TEXT NOT NULL, element_type TEXT, screen_region TEXT, visual_description
 * TEXT, target_package TEXT, layer_reached INTEGER, screenshot_base64 TEXT
 * (nullable), screen_width INTEGER, screen_height INTEGER, source TEXT NOT
 * NULL DEFAULT 'auto_miss', correction_text TEXT, corrected_target JSONB,
 * current_package TEXT, current_activity TEXT, screenshot_hash TEXT,
 * chosen_box JSONB, created_at, reviewed, yolo_label_exported. See
 * sql/detection_failures.sql + migrations/add_correction_fields.sql.
 */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../db');

const VALID_SOURCES = new Set(['auto_miss', 'user_correction', 'auto_success']);

router.post('/', async (req, res) => {
  try {
    const {
      sessionId,
      taskDescription,
      stepNumber,
      findDescription,
      stepDescription, // legacy alias
      elementType,
      screenRegion,
      visualDescription,
      targetPackage,
      layerReached,
      screenshotBase64,
      screenWidth,
      screenHeight,
      source,
      correctionText,
      correctedTarget,
      currentPackage,
      currentActivity,
      screenshotHash,
      chosenBox,
    } = req.body || {};

    const description = findDescription || stepDescription;
    if (!description) {
      return res.status(400).json({ success: false, error: 'findDescription is required' });
    }

    const eventSource = VALID_SOURCES.has(source) ? source : 'auto_miss';
    // Only the original auto_miss path requires a full screenshot —
    // user_correction/auto_success carry their own, lighter-weight evidence
    // (corrected node info / a hash reference) instead.
    if (eventSource === 'auto_miss' && !screenshotBase64) {
      return res.status(400).json({ success: false, error: 'screenshotBase64 is required' });
    }

    await db.query(
      `INSERT INTO detection_failures
        (session_id, task_description, step_number, find_description, element_type,
         screen_region, visual_description, target_package, layer_reached,
         screenshot_base64, screen_width, screen_height, source, correction_text,
         corrected_target, current_package, current_activity, screenshot_hash, chosen_box)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        sessionId || crypto.randomUUID(),
        taskDescription || null,
        Number.isInteger(stepNumber) ? stepNumber : null,
        description,
        elementType || null,
        screenRegion || null,
        visualDescription || null,
        targetPackage || null,
        Number.isInteger(layerReached) ? layerReached : null,
        screenshotBase64 || null,
        Number.isInteger(screenWidth) ? screenWidth : null,
        Number.isInteger(screenHeight) ? screenHeight : null,
        eventSource,
        correctionText || null,
        correctedTarget ? JSON.stringify(correctedTarget) : null,
        currentPackage || null,
        currentActivity || null,
        screenshotHash || null,
        chosenBox ? JSON.stringify(chosenBox) : null,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('/failure error:', err.message);
    res.status(500).json({ success: false, error: 'Database error' });
  }
});

module.exports = router;
