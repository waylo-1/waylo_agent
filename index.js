/**
 * Waylo Backend - Main Express Server
 * AI-powered smartphone guide for elderly users
 *
 * Required env vars:
 *   DATABASE_URL          - AWS RDS/Aurora Postgres connection string (pgvector)
 *   AI_PROVIDER            - "bedrock" (default) or "gemini" — see services/llm.js
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION  - required if AI_PROVIDER=bedrock
 *   BEDROCK_TEXT_MODEL_ID, BEDROCK_VISION_MODEL_ID, BEDROCK_OBJECT_DETECT_MODEL_ID,
 *   BEDROCK_EMBED_MODEL_ID                                - Bedrock model ids
 *   GEMINI_API_KEY, GEMINI_TEXT_MODEL, GEMINI_VISION_MODEL - required if AI_PROVIDER=gemini
 *   PORT                  - server port (default 3000)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { detectLanguage } = require('./langdetect');
const { generateDesktopSteps, generateEnrichedSteps, recoverDesktopStep, detectObject, answerConcept, answerWithScreen, isQuotaOrThrottleError } = require('./services/llm');
const planCache = require('./planCache');
const db = require('./db');
const semanticPlanCache = require('./semanticPlanCache');
const stepLabelCache = require('./stepLabelCache');
const visionRouter = require('./routes/vision');
const visionFallbackRouter = require('./routes/vision-fallback');
const failureRouter = require('./routes/failure');
const yoloDetectRoute = require('./routes/yolo-detect');

const app = express();
const PORT = process.env.PORT || 3000;

// Don't advertise the framework.
app.disable('x-powered-by');

// Basic security response headers (no external dependency).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
});

// CORS: if ALLOWED_ORIGINS is set (comma-separated), restrict to it; otherwise
// allow all (the macOS app is a native client and sends no Origin header).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length
  ? { origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)) }
  : {}));

// Raised limit: /vision receives Base64 JPEG screenshots which exceed the
// default 100kb body limit.
app.use(express.json({ limit: '12mb' }));

// Global rate limiter — protects every endpoint from abuse. /plan keeps its
// own tighter limiter below.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' },
});
app.use(globalLimiter);

// Rate limiter for /plan endpoint
const planLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  message: { error: 'Too many requests, please wait a minute' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

/**
 * POST /plan
 * Generate step-by-step instructions for a task
 */
app.post('/plan', planLimiter, async (req, res) => {
  try {
    const { task, platform } = req.body;

    if (!task || typeof task !== 'string' || task.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Task is required and must be a non-empty string'
      });
    }

    // macOS desktop companion (Waylo Desktop) uses a different element model
    // and expects { task, app, steps:[{ index, instruction, findDescription }] }.
    if (platform === 'macos') {
      console.log(`Plan requested (macOS): ${task}`);

      // Optional live-screen grounding from the macOS client (AX-tree snapshot).
      const screenContext = typeof req.body.screenContext === 'string'
        ? req.body.screenContext : '';

      // Semantic cache (Aurora/pgvector) is OPTIONAL here: this backend may run
      // without a DB (e.g. Cloud Run). If it's reachable, a paraphrase returns
      // instantly; if not, we just generate a fresh plan. Grounded plans skip
      // the cache read (the live screen changes the right answer).
      if (!screenContext) {
        try {
          const cachedPlan = await semanticPlanCache.getPlanFromCache('macos', task);
          if (cachedPlan) {
            console.log(`Plan semantic-cache HIT (macOS) for: ${task}`);
            return res.json({ ...cachedPlan, cached: true });
          }
        } catch (cacheErr) {
          console.warn('Semantic cache unavailable (macOS) — generating fresh:', cacheErr.message);
        }
      } else {
        console.log(`Plan grounding (macOS): ${screenContext.length} chars of screen context`);
      }

      // The plan BRAIN: GenKit + Gemini 3.5 (structured desktop plan). Lazy-
      // required so the server still boots if GenKit isn't configured.
      let plan;
      try {
        const { planFlow } = require('./services/agent');
        plan = await planFlow({ task, screenContext });
      } catch (genError) {
        console.error('Plan generation failed (macOS, GenKit):', genError.message);
        return res.status(500).json({
          success: false,
          error: 'Failed to generate plan',
          details: genError.message,
        });
      }

      console.log(`GenKit desktop plan: ${plan.steps?.length || 0} steps`);

      // Store for next time (fire-and-forget; only non-empty, non-grounded plans).
      // Swallows a missing/failed DB — caching is best-effort.
      if (plan.steps && plan.steps.length > 0 && !screenContext) {
        semanticPlanCache.storePlanInCache('macos', task, plan).then(() => {}, () => {});
      }
      return res.json(plan);
    }

    // Detect language
    const language = detectLanguage(task);
    console.log(`Plan requested: ${task} | Language detected: ${language}`);

    // Serve from the server-side cache when possible — repeat tasks cost $0.
    const cached = planCache.get(task);
    if (cached) {
      console.log(`Plan cache HIT for: ${task}`);
      return res.json({
        success: true,
        appPackage: cached.appPackage,
        appName: cached.appName,
        language,
        steps: cached.steps,
        totalSteps: cached.steps.length,
        cached: true
      });
    }

    // Generate enriched 8-field steps. The richer per-step metadata gives the
    // Android detection layers much more signal to match against, reducing
    // costly vision fallbacks.
    let plan;
    try {
      plan = await generateEnrichedSteps(task);
    } catch (genError) {
      if (!isQuotaOrThrottleError(genError)) throw genError;

      console.warn(`Plan generation throttled for "${task}" — trying a degraded semantic-cache match`);
      const fallbackPlan = await semanticPlanCache.getPlanFromCache(
        'android', task, semanticPlanCache.QUOTA_FALLBACK_SIMILARITY_THRESHOLD
      );
      if (fallbackPlan) {
        console.log(`Plan quota-fallback HIT (degraded similarity) for: ${task}`);
        return res.json({
          success: true,
          appPackage: fallbackPlan.appPackage,
          appName: fallbackPlan.appName,
          language,
          steps: fallbackPlan.steps,
          totalSteps: fallbackPlan.steps.length,
          cached: true,
          degraded: true,
        });
      }

      console.error('Plan generation throttled and no cache fallback available:', genError.message);
      return res.status(429).json({
        success: false,
        error: 'AI service is temporarily busy. Please try again in a moment.',
        code: 'quota_exceeded',
      });
    }
    console.log(`Bedrock response received, ${plan.steps.length} enriched steps parsed`);

    // Cache for next time (only worth caching a non-empty plan).
    if (plan.steps.length > 0) {
      planCache.set(task, '', plan);
      // Also store in the semantic (pgvector) cache so a paraphrase can still
      // be served — including as a degraded fallback above — if the live model
      // is throttled later. Fire-and-forget; failures are swallowed.
      semanticPlanCache.storePlanInCache('android', task, {
        appPackage: plan.appPackage,
        appName: plan.appName,
        steps: plan.steps,
      }).then(() => {}, () => {});
    }

    res.json({
      success: true,
      appPackage: plan.appPackage,
      appName: plan.appName,
      language,
      steps: plan.steps,
      totalSteps: plan.steps.length
    });

  } catch (error) {
    console.error('Error in /plan:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate plan',
      details: error.message
    });
  }
});

// Vision endpoint (Layer 3: locate + troubleshoot)
app.use('/vision', visionRouter);

// Vision fallback endpoint for the macOS desktop companion
app.use('/vision-fallback', visionFallbackRouter);

/**
 * POST /label/lookup
 * Returns a previously-cached working AX label for a step, if any.
 * Body: { appName, stepDescription }
 */
app.post('/label/lookup', async (req, res) => {
  try {
    const { appName, stepDescription } = req.body || {};
    if (!appName || !stepDescription) return res.json({ found: false });
    const label = await stepLabelCache.getLabelFromCache(appName, stepDescription);
    return res.json(label ? { found: true, axLabel: label } : { found: false });
  } catch (e) {
    console.error('Error in /label/lookup:', e.message);
    return res.json({ found: false });
  }
});

/**
 * POST /label/store
 * Caches a working AX label for a step (fire-and-forget). 202 immediately.
 * Body: { appName, stepDescription, axLabel }
 */
app.post('/label/store', (req, res) => {
  const { appName, stepDescription, axLabel } = req.body || {};
  if (appName && stepDescription && axLabel) {
    stepLabelCache.storeLabelInCache(appName, stepDescription, axLabel).then(() => {}, () => {});
  }
  return res.status(202).json({ accepted: true });
});

/**
 * POST /qa
 * Mid-session concept question — plain text answer (no vision).
 * Body: { question, appName }
 */
app.post('/qa', async (req, res) => {
  try {
    const { question, appName } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question is required' });
    }
    const answer = await answerConcept({ question, appName: appName || '' });
    return res.json({ answer });
  } catch (error) {
    console.error('Error in /qa:', error.message);
    return res.status(500).json({ error: 'qa failed', details: error.message });
  }
});

/**
 * POST /ask-screen
 * Vision Q&A — answers a free-form question about what's on the user's screen,
 * using a screenshot (for learning). No pointer, just an explanation.
 * Body: { question, screenshot, appName }
 */
app.post('/ask-screen', async (req, res) => {
  try {
    const { question, screenshot, appName } = req.body || {};
    if (!question || !screenshot) {
      return res.status(400).json({ error: 'question and screenshot are required' });
    }
    const answer = await answerWithScreen({ question, screenshot, appName: appName || '' });
    return res.json({ answer });
  } catch (error) {
    console.error('Error in /ask-screen:', error.message);
    return res.status(500).json({ error: 'ask-screen failed', details: error.message });
  }
});

/**
 * POST /nova-vision
 * Layer 3 grounding via Nova 2 Lite object detection.
 * Body: { image_base64, target_label, step_instruction }
 * Returns: { found, bbox: [xMin,yMin,xMax,yMax] (0-1000), label } or { found: false }
 */
app.post('/nova-vision', async (req, res) => {
  try {
    const { image_base64, target_label, step_instruction } = req.body || {};
    if (!image_base64 || !target_label) {
      return res.status(400).json({ found: false, error: 'image_base64 and target_label are required' });
    }
    const result = await detectObject({
      screenshot: image_base64,
      targetLabel: target_label,
      stepInstruction: step_instruction || '',
      // Words the client's local OCR read — free grounding context (capped).
      ocrContext: typeof req.body.ocr_context === 'string'
        ? req.body.ocr_context.slice(0, 1200) : '',
    });
    return res.json(result);
  } catch (error) {
    console.error('Error in /nova-vision:', error.message);
    return res.status(200).json({ found: false });
  }
});

/**
 * POST /recover
 * Self-healing: when the desktop app can't locate an element, it sends a
 * screenshot. The model relabels the element or replans the remaining steps.
 */
app.post('/recover', async (req, res) => {
  try {
    const { screenshot, task, instruction, targetLabel, stepIndex = 0, totalSteps = 1, userMessage } = req.body || {};
    if (!screenshot || !task) {
      return res.status(400).json({ error: 'screenshot and task are required' });
    }
    const result = await recoverDesktopStep({
      screenshot,
      task,
      instruction: instruction || '',
      targetLabel: targetLabel || '',
      stepIndex,
      totalSteps,
      userMessage: userMessage || '',
    });
    return res.json(result);
  } catch (error) {
    console.error('Error in /recover:', error.message);
    return res.status(500).json({ error: 'recover failed', details: error.message });
  }
});

// Detection failure logging endpoint (stores misses for future YOLO training)
app.use('/failure', failureRouter);

/**
 * POST /plan/learn
 * Remembers a CORRECTED plan after a guide completed whose steps were changed
 * mid-run. Keyed by the original task text, so the same task is right next time.
 * Body: { task, platform, steps:[...] }
 */
app.post('/plan/learn', async (req, res) => {
  try {
    const { task, platform, steps } = req.body || {};
    if (!task || typeof task !== 'string' || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ accepted: false, error: 'task and non-empty steps are required' });
    }
    if ((platform || 'macos') !== 'macos') {
      return res.status(202).json({ accepted: false }); // only desktop plans are cached this way
    }
    const REGIONS = ['menuBar', 'ribbon', 'dialog', 'sidebar', 'spreadsheet', 'statusBar', 'fullScreen'];
    const normalized = steps.map((s, i) => ({
      index: typeof s.index === 'number' ? s.index : i + 1,
      action: ['click', 'type', 'key', 'info'].includes(s.action) ? s.action : 'click',
      instruction: typeof s.instruction === 'string' ? s.instruction : '',
      targetLabel: typeof s.targetLabel === 'string' ? s.targetLabel : '',
      elementDescription: s.elementDescription || s.findDescription || s.instruction || '',
      screenRegion: REGIONS.includes(s.screenRegion) ? s.screenRegion : 'fullScreen',
      targetType: s.targetType === 'icon' ? 'icon' : 'text',
      controlKind: typeof s.controlKind === 'string' ? s.controlKind : '',
      anchorText: typeof s.anchorText === 'string' ? s.anchorText : '',
      anchorPosition: typeof s.anchorPosition === 'string' ? s.anchorPosition : '',
      key: typeof s.key === 'string' ? s.key : null,
      findDescription: s.findDescription || s.elementDescription || s.instruction || '',
    }));
    const plan = { task, app: 'Unknown', steps: normalized };
    // Fire-and-forget so the client isn't blocked.
    semanticPlanCache.learnPlan('macos', task, plan).then(() => {}, () => {});
    return res.status(202).json({ accepted: true });
  } catch (error) {
    console.error('Error in /plan/learn:', error.message);
    return res.status(500).json({ accepted: false, error: error.message });
  }
});

/**
 * POST /plan/forget
 * Marks a plan WRONG: removes it from the cache so it isn't reused.
 * Body: { task, platform }
 */
app.post('/plan/forget', (req, res) => {
  const { task, platform } = req.body || {};
  if (task && typeof task === 'string' && (platform || 'macos') === 'macos') {
    semanticPlanCache.forgetPlan('macos', task).then(() => {}, () => {});
  }
  return res.status(202).json({ accepted: true });
});

// Layer 2.5: dual-model YOLO detection (proxies to the Python microservice)
app.use('/', yoloDetectRoute);

/**
 * POST /guide
 * Save a guide to database and return shareable link
 */
app.post('/guide', async (req, res) => {
  try {
    const { steps, taskName } = req.body;

    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ success: false, error: 'Steps array is required and must not be empty' });
    }
    if (!taskName || typeof taskName !== 'string') {
      return res.status(400).json({ success: false, error: 'Task name is required' });
    }

    const id = generateRandomId(8);
    await db.query(
      'INSERT INTO guides (id, task, steps_json) VALUES ($1, $2, $3)',
      [id, taskName, JSON.stringify(steps)]
    );

    console.log(`Guide saved: ${id}`);
    res.json({
      success: true,
      id,
      link: `https://waylo.app/g/${id}`
    });
  } catch (error) {
    console.error('Error in /guide:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save guide',
      details: error.message
    });
  }
});


/**
 * GET /guide/:id
 * Retrieve a saved guide by ID
 */
app.get('/guide/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || id.length !== 8) {
      return res.status(400).json({
        success: false,
        error: 'Invalid guide ID'
      });
    }

    const { rows } = await db.query('SELECT * FROM guides WHERE id = $1', [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Guide not found'
      });
    }

    const row = rows[0];
    let steps = [];
    try {
      steps = JSON.parse(row.steps_json);
    } catch (_) {
      steps = [];
    }

    // Best-effort open counter (column exists in the AWS schema).
    db.query('UPDATE guides SET opens = opens + 1 WHERE id = $1', [id]).catch(() => {});

    res.json({
      success: true,
      taskName: row.task,
      steps,
      totalSteps: steps.length
    });

  } catch (error) {
    console.error('Error in /guide/:id:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve guide',
      details: error.message
    });
  }
});

/**
 * Utility function to generate random alphanumeric ID
 * @param {number} length - Length of the ID
 * @returns {string} Random alphanumeric string
 */
function generateRandomId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Start server
// ── Agentic endpoint (GenKit + Gemini 3.5) ────────────────────────────────
// Decides ONE next step from the live screen. The Android app calls this after
// each action with the updated screen, so the agent can continue, recover from
// an unexpected screen, or mark the goal done. Lazy-required so the server still
// boots if GenKit isn't configured.
app.post('/agent/next', async (req, res) => {
  try {
    const { nextStepFlow } = require('./services/agent');
    const memory = require('./services/memory');
    const { goal, appName, appPackage, screen, history, answers, userId } = req.body || {};
    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({ success: false, error: 'goal (string) is required' });
    }

    // PERSISTENT MEMORY: load what this user has told us in PAST sessions and
    // merge it with anything sent this session, so the agent adapts to the person
    // and never re-asks something they already answered — even across sessions.
    const remembered = await memory.loadMemory(userId);
    const sessionAnswers = Array.isArray(answers) ? answers : [];
    const seen = new Set();
    const mergedAnswers = [...remembered.answers, ...sessionAnswers]
      .filter((a) => a && a.question && a.answer)
      .filter((a) => { const k = a.question + ' ' + a.answer; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((a) => ({ question: a.question, answer: a.answer }));

    const decision = await nextStepFlow({
      goal,
      appName,
      appPackage,
      screen,
      history: Array.isArray(history) ? history : [],
      answers: mergedAnswers,
    });

    // Persist this turn (this session's answers + the goal) for future sessions.
    await memory.remember(userId, { goal, answers: sessionAnswers });

    return res.json({ success: true, memoryUsed: remembered.answers.length, ...decision });
  } catch (err) {
    console.error('[agent/next]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Waylo backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
