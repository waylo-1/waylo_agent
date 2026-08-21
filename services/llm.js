/**
 * Waylo's single AI entry point. Every route calls into this module only —
 * never into services/providers/* directly — so switching providers never
 * requires touching route code.
 *
 * Provider selection: AI_PROVIDER=bedrock|gemini (default: bedrock).
 * Only the selected provider's module is require()'d, so e.g. running with
 * AI_PROVIDER=gemini never needs AWS credentials, and vice versa.
 *
 * Prompts, output schemas and normalization live in ./promptSpecs.js and are
 * shared across providers — this guarantees /plan and /vision return the
 * exact same JSON shape (the one the Android app parses) regardless of which
 * model produced it.
 */

const specs = require('./promptSpecs');

const PROVIDER = (process.env.AI_PROVIDER || 'bedrock').toLowerCase();

let raw;
if (PROVIDER === 'gemini') {
  raw = require('./providers/gemini');
} else if (PROVIDER === 'bedrock') {
  raw = require('./providers/bedrock');
} else {
  throw new Error(`Unknown AI_PROVIDER "${process.env.AI_PROVIDER}" — expected "bedrock" or "gemini"`);
}

console.log(`[llm] AI_PROVIDER=${PROVIDER}`);

// ── Generic passthroughs (used by routes with their own prompts) ───────────

/** Low-level text-only call. Returns raw model text (not fence-stripped). */
async function askText(opts) {
  return raw.askText(opts);
}

/** Low-level single-image call. Returns raw model text (not fence-stripped). */
async function askVision(opts) {
  return raw.askVision(opts);
}

const { stripFences } = specs;

/**
 * Classifies an error thrown by a provider call as "the AI is temporarily
 * unavailable" (throttling, rate limits, quota exhaustion, or an account/API
 * key access hold) as opposed to a genuine bug. Checked across both providers:
 * Bedrock throws AWS SDK errors with $metadata.httpStatusCode/name, Gemini
 * throws plain Errors with the HTTP status folded into the message text.
 *
 * NOTE: a bare 403 is NOT enough on its own — AWS also returns 403 for plain
 * invalid-credentials errors (e.g. UnrecognizedClientException), which are a
 * real bug, not a transient condition. Only treat 403 as quota-like when the
 * name/message actually says so (AccessDenied, "being verified", etc.).
 */
function isQuotaOrThrottleError(err) {
  const status = err?.$metadata?.httpStatusCode;
  const haystack = `${err?.name || ''} ${err?.message || ''}`;
  return (
    status === 429 ||
    /throttl|toomanyrequests|quota|rate.?limit|resource.?exhausted|accessdenied|being verified/i.test(haystack)
  );
}

// ── POST /plan (Android) ────────────────────────────────────────────────────

/**
 * Generates the enriched Android plan. Returns { appPackage, appName, steps }
 * where each step has at least { stepNumber, instruction, findDescription } —
 * this is the shape the Android Step model parses; do not change field names
 * without a corresponding Android change.
 */
async function generateEnrichedSteps(task) {
  const text = await raw.askText({
    system: specs.ENRICHED_SYSTEM_PROMPT,
    prompt: `Task: ${task}`,
    // Deeper plans (5-10 granular steps, per the elderly-friendly rewrite) run
    // longer than the old 2-4 step output; give the model headroom so it isn't
    // truncated mid-JSON.
    maxTokens: 3000,
    temperature: 0.3,
  });

  console.log('[llm] enriched plan raw response:', text.substring(0, 200));

  const plan = specs.parseEnrichedPlan(text, task);
  console.log(`[llm] enriched plan: appPackage=${plan.appPackage} appName=${plan.appName} steps=${plan.steps.length}`);
  return plan;
}

// ── POST /plan (macOS desktop) ──────────────────────────────────────────────

/** Generates the macOS desktop guide plan. Returns { task, app, steps }.
 *
 * `screenContext` (optional): a compact snapshot of the user's LIVE screen —
 * frontmost app, window title, and the visible interactive elements from the
 * accessibility tree — sent by the macOS client. Grounding the planner in
 * what is actually on screen means: no "open the app" step when it's already
 * frontmost, and targetLabels copied from REAL visible labels instead of
 * guessed ones (the #1 cause of detection misses). */
async function generateDesktopSteps(task, screenContext) {
  let prompt = `Task: ${task}`;
  if (screenContext && typeof screenContext === 'string' && screenContext.trim()) {
    // Cap so a huge tree can't blow the token budget.
    const ctx = screenContext.trim().slice(0, 2400);
    prompt += `

Live screen snapshot (from the user's accessibility tree, captured just now):
${ctx}

Ground the plan in this snapshot:
- If the app needed for the task is already frontmost, do NOT add a step to open it — start from the visible state, and set the plan's "app" field to that frontmost app's exact name.
- When a visible element in the snapshot matches a step's target, copy its EXACT title into targetLabel (real labels beat guessed ones).
- If the task needs an app that is NOT in the snapshot, plan its launch normally (Dock/Spotlight).`;
  }

  const text = await raw.askText({
    system: specs.getDesktopSystemPrompt(),
    prompt,
    maxTokens: 1500,
    temperature: 0.3,
  });

  return specs.parseDesktopPlan(text);
}

// ── POST /recover (macOS desktop self-healing) ──────────────────────────────

async function recoverDesktopStep({ screenshot, task, instruction, targetLabel, stepIndex, totalSteps, userMessage }) {
  const text = await raw.askVision({
    system: specs.getRecoverySystemPrompt(),
    prompt: specs.getRecoveryUserText({ task, stepIndex, totalSteps, instruction, targetLabel, userMessage }),
    imageBase64: screenshot,
    maxTokens: 1200,
    temperature: 0.2,
  });

  return specs.parseRecoveryResponse(text);
}

// ── POST /nova-vision (object-detection grounding) ──────────────────────────

async function detectObject({ screenshot, targetLabel, stepInstruction, ocrContext }) {
  const prompt = specs.getDetectionPrompt(targetLabel, stepInstruction, ocrContext);

  const text = await raw.askObjectDetection({
    prompt,
    imageBase64: screenshot,
    maxTokens: 400,
    temperature: 0.0,
  });

  if (process.env.NOVA_DEBUG) console.log('[detectObject] RAW:', text);
  return specs.parseDetectionResponse(text, targetLabel);
}

// ── POST /qa, POST /ask-screen ──────────────────────────────────────────────

async function answerConcept({ question, appName }) {
  const text = await raw.askText({
    system: specs.getConceptSystemPrompt(appName),
    prompt: question,
    maxTokens: 200,
    temperature: 0.3,
  });
  return text.trim();
}

async function answerWithScreen({ question, screenshot, appName }) {
  const text = await raw.askVision({
    system: specs.getScreenQaSystemPrompt(appName),
    prompt: `Question: ${question}`,
    imageBase64: screenshot,
    maxTokens: 400,
    temperature: 0.3,
  });
  return text.trim();
}

module.exports = {
  provider: PROVIDER,
  askText,
  askVision,
  stripFences,
  isQuotaOrThrottleError,
  generateEnrichedSteps,
  generateDesktopSteps,
  recoverDesktopStep,
  detectObject,
  answerConcept,
  answerWithScreen,
};
