/**
 * Persistent, cross-session memory for the Waylo agent — backed by Google Cloud
 * Firestore. This is what makes Waylo a COLLABORATIVE PARTNER rather than a
 * one-shot task-runner: what a user tells the agent (their answers to clarifying
 * questions, the goals they pursue) is remembered ACROSS SESSIONS, keyed by user.
 * Next time, the agent doesn't start from zero or re-ask what it already knows —
 * it adapts to that person.
 *
 * Degrades gracefully: off Cloud Run (or if Firestore isn't reachable) every call
 * is a safe no-op and the agent still works statelessly. Memory is an enhancement,
 * never a hard dependency — so local dev and a Firestore-less deploy both boot fine.
 * Enabled automatically on Cloud Run (K_SERVICE is set there), or locally by
 * setting ENABLE_FIRESTORE=1.
 */

const COLLECTION = process.env.FIRESTORE_COLLECTION || 'waylo_memory';
const MAX_ANSWERS = 25;
const MAX_GOALS = 15;

let db = null;
let initTried = false;

function firestore() {
  if (initTried) return db;
  initTried = true;
  // Only touch Firestore where it's actually available (Cloud Run) or explicitly
  // opted into — avoids noisy credential errors during local dev.
  if (!process.env.K_SERVICE && !process.env.ENABLE_FIRESTORE) return null;
  try {
    const { Firestore } = require('@google-cloud/firestore');
    db = new Firestore(); // uses Application Default Credentials on Cloud Run
    console.log('[memory] Firestore persistent memory ENABLED');
  } catch (e) {
    console.warn('[memory] Firestore unavailable — running without persistent memory:', e.message);
    db = null;
  }
  return db;
}

const dedupAnswers = (arr) =>
  arr.filter((a, i) => a && a.question && a.answer &&
    arr.findIndex((x) => x.question === a.question && x.answer === a.answer) === i);

/** Load a user's remembered answers + recent goals. Empty when no memory/user. */
async function loadMemory(userId) {
  const fs = firestore();
  if (!fs || !userId) return { answers: [], recentGoals: [] };
  try {
    const snap = await fs.collection(COLLECTION).doc(String(userId)).get();
    if (!snap.exists) return { answers: [], recentGoals: [] };
    const d = snap.data() || {};
    return {
      answers: Array.isArray(d.answers) ? d.answers : [],
      recentGoals: Array.isArray(d.recentGoals) ? d.recentGoals : [],
    };
  } catch (e) {
    console.warn('[memory] load failed:', e.message);
    return { answers: [], recentGoals: [] };
  }
}

/** Persist this session's answers + goal so a FUTURE session remembers them. */
async function remember(userId, { goal, answers } = {}) {
  const fs = firestore();
  if (!fs || !userId) return;
  try {
    const ref = fs.collection(COLLECTION).doc(String(userId));
    const snap = await ref.get();
    const cur = snap.exists ? (snap.data() || {}) : {};

    let mergedAnswers = dedupAnswers([
      ...(Array.isArray(cur.answers) ? cur.answers : []),
      ...((answers || []).map((a) => ({ question: a.question, answer: a.answer, at: Date.now() }))),
    ]);
    if (mergedAnswers.length > MAX_ANSWERS) mergedAnswers = mergedAnswers.slice(-MAX_ANSWERS);

    let goals = Array.isArray(cur.recentGoals) ? cur.recentGoals.slice() : [];
    if (goal) {
      goals.push({ goal: String(goal).slice(0, 120), at: Date.now() });
      if (goals.length > MAX_GOALS) goals = goals.slice(-MAX_GOALS);
    }

    await ref.set({ answers: mergedAnswers, recentGoals: goals, updatedAt: Date.now() }, { merge: true });
  } catch (e) {
    console.warn('[memory] save failed:', e.message);
  }
}

module.exports = { loadMemory, remember };
