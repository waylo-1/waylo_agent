/**
 * Step label cache (AWS RDS Postgres + pgvector + Titan embeddings).
 *
 * Caches the working label from a recovery relabel so future runs resolve via
 * AX directly, skipping the vision fallback. All failures swallowed.
 *
 * AWS schema (step_label_cache): id BIGSERIAL, step_description TEXT,
 *   label TEXT, embedding vector(1536), created_at.
 * RPC: match_step_label_cache(query_embedding vector, match_threshold float,
 *   match_count int) -> (id, step_description, label, similarity)
 *
 * NOTE: the AWS table has no app_name column, so `appName` is accepted for
 * call-site compatibility but not used in the query.
 */
const db = require('./db');
const { embedText } = require('./embeddings');

const LABEL_SIMILARITY_THRESHOLD = 0.93;

function toVector(arr) {
  return `[${arr.join(',')}]`;
}

async function getLabelFromCache(appName, stepDescription) {
  try {
    const embedding = await embedText(stepDescription);
    const { rows } = await db.query(
      'SELECT * FROM match_step_label_cache($1::vector, $2, $3)',
      [toVector(embedding), LABEL_SIMILARITY_THRESHOLD, 1]
    );
    if (!rows || rows.length === 0) return null;
    return rows[0].label;
  } catch (e) {
    console.error('[stepLabelCache] getLabelFromCache:', e.message);
    return null;
  }
}

async function storeLabelInCache(appName, stepDescription, axLabel) {
  try {
    const embedding = await embedText(stepDescription);
    await db.query(
      'INSERT INTO step_label_cache (step_description, label, embedding) VALUES ($1, $2, $3::vector)',
      [stepDescription, axLabel, toVector(embedding)]
    );
  } catch (e) {
    console.error('[stepLabelCache] storeLabelInCache:', e.message);
  }
}

module.exports = { getLabelFromCache, storeLabelInCache };
