// backend_initial/routes/vision.js
// POST /vision — Claude (AWS Bedrock) vision for element location and troubleshooting.
//
// Two modes:
//   "locate"       — find an expected element on screen, return (x, y)
//   "troubleshoot" — element missing, analyze screen and generate new steps
//
// Uses the shared Bedrock Converse client (bedrock.js). AWS credentials stay
// server-side. Set WAYLO_DEBUG=1 to log full prompts and raw model responses.

const express = require('express');
const router = express.Router();

const { askVision, stripFences } = require('../services/llm');

const DEBUG = process.env.WAYLO_DEBUG === '1';

// ── Prompts ─────────────────────────────────────────────────────────────────
const LOCATE_PROMPT = (task, stepIndex, totalSteps, findDescription, width, height) => `
You are helping an elderly user tap the correct element on their Android phone screen.

Task: "${task}"
We are on step ${stepIndex + 1} of ${totalSteps}.
We are looking for: "${findDescription}"

Look at this screenshot carefully.

If you can see the element (even if named slightly differently): return its center pixel coordinates.
The phone screen resolution is ${width}x${height}. Top-left is (0,0).
If you genuinely cannot see it anywhere: set found=false.

Return ONLY this JSON, nothing else:
{
  "found": true/false,
  "x": <pixel x of element center>,
  "y": <pixel y of element center>,
  "confidence": 0.0-1.0,
  "whatYouSee": "<one line description of what's at that location>",
  "updatedFindDescription": "<corrected description if element name was wrong>"
}
`.trim();

const TROUBLESHOOT_PROMPT = (task, stepIndex, totalSteps, findDescription, language, width, height) => `
You are helping an elderly Indian user complete a task on their Android phone.
The guidance app got stuck because an expected element is missing from the screen.

Original task: "${task}"
Stuck on step ${stepIndex + 1} of ${totalSteps}: looking for "${findDescription}"
Screen resolution: ${width}x${height}

Analyze the screenshot and figure out:
1. WHY is the element missing? (signed out, wrong screen, feature needs subscription, UI changed, etc.)
2. What should the user do to get back on track?

Generate clear, simple recovery steps. Instructions must be short and warm —
this user is elderly and not tech-savvy.
Write the "instruction" fields in ${language === 'hi' ? 'Hindi' : 'simple English'}.
The "findDescription" fields must always be in English.

Return ONLY this JSON:
{
  "recoverable": true/false,
  "rootCause": "<one line: why the element is missing>",
  "explanation": "<spoken aloud to user, 1 sentence, simple language>",
  "newSteps": [
    {
      "stepNumber": 1,
      "instruction": "<what to do, simple language>",
      "findDescription": "<English description of UI element to tap>"
    }
  ]
}

If not recoverable (feature doesn't exist, needs paid plan, etc.):
set recoverable=false, newSteps=[], and explain clearly in "explanation".
`.trim();

// ── Vision call with one retry on throttling ────────────────────────────────
async function callModel(prompt, screenshotBase64) {
  const opts = { prompt, imageBase64: screenshotBase64, maxTokens: 1500, temperature: 0.2 };

  try {
    return await askVision(opts);
  } catch (err) {
    // Throttled — wait 5s and retry once before failing.
    if (/throttl|429|rate/i.test(err.message || '')) {
      console.warn('[vision] provider throttled — retrying once in 5s');
      await new Promise((r) => setTimeout(r, 5000));
      return await askVision(opts);
    }
    throw err;
  }
}

// ── Route Handler ────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    mode,
    screenshotBase64,
    task,
    currentStepIndex = 0,
    totalSteps = 1,
    findDescription,
    screenWidth = 1080,
    screenHeight = 2400,
    language = 'en',
  } = req.body || {};

  if (!screenshotBase64 || !task || !findDescription) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!['locate', 'troubleshoot'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'locate' or 'troubleshoot'" });
  }

  try {
    const prompt =
      mode === 'locate'
        ? LOCATE_PROMPT(task, currentStepIndex, totalSteps, findDescription, screenWidth, screenHeight)
        : TROUBLESHOOT_PROMPT(task, currentStepIndex, totalSteps, findDescription, language, screenWidth, screenHeight);

    if (DEBUG) console.log(`[vision/${mode}] prompt:\n${prompt}`);

    const rawText = await callModel(prompt, screenshotBase64);

    if (DEBUG) {
      console.log(`[vision/${mode}] raw response:\n${rawText}`);
    } else {
      console.log(`[vision/${mode}] raw: ${rawText.substring(0, 300)}`);
    }

    const cleaned = stripFences(rawText);

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('[vision] JSON parse failed:', e.message, 'raw:', rawText);
      return res.status(500).json({ error: 'Model returned invalid JSON', raw: rawText });
    }

    console.log(`[vision/${mode}] parsed:`, JSON.stringify(parsed).substring(0, 200));
    return res.json(parsed);
  } catch (err) {
    console.error('[vision] error:', err.message);
    const msg = err.message || 'Vision API failed';
    const status = /throttl|429|rate/i.test(msg) ? 429 : 500;
    return res.status(status).json({ error: msg });
  }
});

module.exports = router;
