/**
 * Semantic plan cache (AWS RDS Postgres + pgvector + Titan embeddings).
 *
 * Matches paraphrases: "freeze the top row" and "lock the first row" embed to
 * nearby vectors and hit the same cached plan. All failures are swallowed — on
 * error we return null so the caller falls through to live generation.
 *
 * AWS schema (plan_cache): id, task TEXT, platform TEXT, steps_json TEXT,
 *   embedding vector(1536). RPC: match_plan_cache(query_embedding, threshold,
 *   count, platform_filter) — filters platform with EXACT equality.
 */
const db = require('./db');
const { embedText } = require('./embeddings');

const PLAN_SIMILARITY_THRESHOLD = 0.92;

// Used only as a degraded fallback when the live model is throttled/unavailable —
// a slightly-looser match still beats a hard failure for the user.
const QUOTA_FALLBACK_SIMILARITY_THRESHOLD = 0.85;

/**
 * Bump the relevant platform's version whenever ITS planning prompt changes
 * meaningfully, to invalidate ALL previously cached plans for that platform
 * (tracked per-platform so improving one prompt doesn't also throw away the
 * other platform's still-good cached plans). The version is folded into the
 * `platform` value (which match_plan_cache filters on with exact equality), so
 * old rows simply stop matching. NOTE: we do NOT fold the version into the
 * embedding text — a short prefix barely moves a Titan vector, so stale plans
 * would still match.
 */
const PLAN_PROMPT_VERSIONS = {
  macos: 'v8',
  // v9 (2026-07-06): granular/landmark-based/elderly-friendly rewrite of
  // ENRICHED_SYSTEM_PROMPT — old shallow plans (e.g. "open app" with no
  // completion steps) must not keep being served from cache.
  // v10 (2026-07-06): stop hard-committing to a screen corner when unsure —
  // old cached plans may assert stale/wrong absolute positions (e.g. account
  // button "top right" when it's actually bottom right in current app UIs).
  // v11 (2026-07-06): app-icon fallbackHint now routes through launcher search
  // instead of sideways swiping; added shortest-in-app-path rule (don't route
  // through Settings when a direct menu entry exists) — old cached plans may
  // still have swipe-paging fallbacks or Settings-routed detours.
  // v12 (2026-07-07): instructions must name exactly ONE element, never hedge
  // between layout variants ("tap either X or Y") — old cached plans may still
  // contain confusing either/or instructions.
  android: 'v12',
};
const versioned = (platform) => `${platform}__${PLAN_PROMPT_VERSIONS[platform] || PLAN_PROMPT_VERSIONS.macos}`;

/** pgvector text literal, e.g. "[0.1,0.2,...]". */
function toVector(arr) {
  return `[${arr.join(',')}]`;
}

/**
 * Returns a cached step plan (parsed object) for a similar task, or null.
 * @param {number} [threshold] - overrides PLAN_SIMILARITY_THRESHOLD. Used to
 *   widen the match (a lower threshold) when the live model is unavailable and
 *   a slightly-less-similar cached plan beats a hard failure.
 */
async function getPlanFromCache(platform, taskText, threshold = PLAN_SIMILARITY_THRESHOLD) {
  try {
    const embedding = await embedText(taskText);
    const { rows } = await db.query(
      'SELECT * FROM match_plan_cache($1::vector, $2, $3, $4)',
      [toVector(embedding), threshold, 1, versioned(platform)]
    );
    if (!rows || rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].steps_json);
    } catch {
      return null;
    }
  } catch (e) {
    console.error('[semanticPlanCache] getPlanFromCache:', e.message);
    return null;
  }
}

/** Stores a generated plan. Non-fatal on error. */
async function storePlanInCache(platform, taskText, stepPlan) {
  try {
    const embedding = await embedText(taskText);
    await db.query(
      'INSERT INTO plan_cache (task, platform, steps_json, embedding) VALUES ($1, $2, $3, $4::vector)',
      [taskText, versioned(platform), JSON.stringify(stepPlan), toVector(embedding)]
    );
  } catch (e) {
    console.error('[semanticPlanCache] storePlanInCache:', e.message);
  }
}

/**
 * Learns a CORRECTED plan: removes any near-duplicate cached plans for this task
 * (so the stale/wrong one can't win) and inserts the corrected one. Called after
 * a guide completes whose plan was changed mid-run — the system remembers the
 * fix so the same task is right next time, with no prompt edit or redeploy.
 */
async function learnPlan(platform, taskText, stepPlan) {
  try {
    const embedding = await embedText(taskText);
    const vec = toVector(embedding);
    const plat = versioned(platform);
    // Drop stale near-identical plans for this task (cosine sim > 0.95).
    await db.query(
      'DELETE FROM plan_cache WHERE platform = $1 AND 1 - (embedding <=> $2::vector) > 0.95',
      [plat, vec]
    );
    await db.query(
      'INSERT INTO plan_cache (task, platform, steps_json, embedding) VALUES ($1, $2, $3, $4::vector)',
      [taskText, plat, JSON.stringify(stepPlan), vec]
    );
    console.log(`[semanticPlanCache] learned corrected plan for "${taskText}"`);
  } catch (e) {
    console.error('[semanticPlanCache] learnPlan:', e.message);
  }
}

/**
 * Forgets a plan the user marked WRONG: deletes cached plans for this task so
 * the bad path is never reused (the next run regenerates fresh).
 */
async function forgetPlan(platform, taskText) {
  try {
    const embedding = await embedText(taskText);
    const { rowCount } = await db.query(
      'DELETE FROM plan_cache WHERE platform = $1 AND 1 - (embedding <=> $2::vector) > 0.90',
      [versioned(platform), toVector(embedding)]
    );
    console.log(`[semanticPlanCache] forgot ${rowCount} plan(s) for "${taskText}"`);
  } catch (e) {
    console.error('[semanticPlanCache] forgetPlan:', e.message);
  }
}

module.exports = {
  getPlanFromCache,
  storePlanInCache,
  learnPlan,
  forgetPlan,
  PLAN_SIMILARITY_THRESHOLD,
  QUOTA_FALLBACK_SIMILARITY_THRESHOLD,
};
