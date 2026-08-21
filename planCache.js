/**
 * Server-side plan cache.
 *
 * Most users ask the same handful of tasks ("send a WhatsApp message",
 * "search a video on YouTube"). Caching generated plans means the 2nd+ request
 * for the same task costs $0 — no Nova call at all.
 *
 * Implementation: in-process Map with TTL. This is intentionally dependency-free
 * so it works on a single Railway instance without provisioning Redis. The
 * interface (get/set) is small enough to swap for Redis later without touching
 * callers.
 */
const crypto = require('crypto');

// taskHash -> { plan, expiresAt, hitCount }
const store = new Map();

// Plans live 7 days — app UIs don't change often.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Cap entries so a long-running instance can't grow unbounded.
const MAX_ENTRIES = 5000;

/** Stable cache key for a task (+ optional app package). */
function keyFor(task, appPackage = '') {
  const normalized = `${String(task).toLowerCase().trim()}::${String(appPackage).toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** Return a cached plan or null if absent/expired. */
function get(task, appPackage = '') {
  const key = keyFor(task, appPackage);
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  entry.hitCount += 1;
  return entry.plan;
}

/** Store a plan. Evicts the oldest entry if the cache is full. */
function set(task, appPackage, plan) {
  if (store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey) store.delete(oldestKey);
  }
  store.set(keyFor(task, appPackage), {
    plan,
    expiresAt: Date.now() + TTL_MS,
    hitCount: 0,
  });
}

/** Diagnostics. */
function stats() {
  return { size: store.size, ttlMs: TTL_MS, maxEntries: MAX_ENTRIES };
}

module.exports = { get, set, keyFor, stats };
