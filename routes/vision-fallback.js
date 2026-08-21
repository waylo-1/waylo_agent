// backend_initial/routes/vision-fallback.js
// POST /vision-fallback — desktop (macOS) screenshot analysis.
//
// Waylo Desktop sends a full-screen JPEG (base64) when its local Accessibility
// search fails to locate an element. Claude (AWS Bedrock) inspects the
// screenshot and returns a corrected element description the app can re-search.
//
// Uses the shared Bedrock Converse client (bedrock.js). AWS credentials stay
// server-side. The screenshot is never logged or persisted.

const express = require('express');
const router = express.Router();

const { askVision, stripFences } = require('../services/llm');

const FALLBACK_PROMPT = (task, stepIndex, totalSteps, findDescription, width, height) => `
You help a desktop guidance app find a UI element when normal methods fail.
Task: ${task}
Current step: ${stepIndex} of ${totalSteps}
Expected element: ${findDescription}

The screenshot is ${width}x${height} pixels. The top-left corner is (0,0),
x increases to the right, y increases downward.

Find the element the user should click. Look carefully at toolbars, menus,
ribbons and buttons.

Return ONLY valid JSON, no markdown:
{
  "elementFound": true or false,
  "x": <integer pixel x of the CENTER of the element>,
  "y": <integer pixel y of the CENTER of the element>,
  "confidence": <0.0 to 1.0>,
  "updatedFindDescription": "corrected English description of the element",
  "instruction": "short updated instruction for the user",
  "reasoning": "one line: what you see at that location"
}

If the element is genuinely not visible anywhere on screen, set "elementFound": false
and omit x/y.
`.trim();

router.post('/', async (req, res) => {
  const {
    screenshot,
    task,
    stepIndex = 0,
    totalSteps = 1,
    findDescription,
    imageWidth = 0,
    imageHeight = 0,
  } = req.body || {};

  if (!screenshot || !task || !findDescription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const prompt = FALLBACK_PROMPT(task, stepIndex, totalSteps, findDescription, imageWidth, imageHeight);

    const rawText = await askVision({
      prompt,
      imageBase64: screenshot,
      maxTokens: 1000,
      temperature: 0.2,
    });

    const cleaned = stripFences(rawText);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('[vision-fallback] JSON parse failed:', e.message);
      return res.status(500).json({ error: 'Model returned invalid JSON' });
    }

    // IMPORTANT: never log or store the screenshot data.
    return res.json(parsed);
  } catch (err) {
    console.error('[vision-fallback] error:', err.message);
    const msg = err.message || 'Vision fallback failed';
    const status = /throttl|429|rate/i.test(msg) ? 429 : 500;
    return res.status(status).json({ error: msg });
  }
});

module.exports = router;
