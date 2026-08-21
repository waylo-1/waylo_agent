/**
 * PostgreSQL connection pool (AWS RDS / Aurora).
 *
 * Replaces the Supabase client. Set DATABASE_URL to the RDS connection string,
 * e.g. postgres://USER:PASSWORD@HOST:5432/DBNAME
 *
 * The pool is created once at module load and reused (App Runner warm instances
 * share it). SSL is required by RDS; rejectUnauthorized:false keeps it simple
 * without bundling the RDS CA (tighten later if needed).
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const query = (text, params) => pool.query(text, params);

module.exports = { pool, query };
