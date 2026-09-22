import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';

const { Pool } = pg;

let _pool;

export function getPool() {
  if (!_pool) {
    _pool = new Pool({ connectionString: config.databaseUrl });
  }
  return _pool;
}

/**
 * Creates the indexer's own tables if they don't exist. Deliberately a
 * plain schema-file execution rather than a migration framework — this
 * is a small, single-owner schema (see README "ownership boundary");
 * reach for Alembic-equivalent migration tooling if it ever needs
 * versioned schema changes beyond additive CREATE TABLE IF NOT EXISTS.
 */
export async function ensureSchema() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.resolve(__dirname, '../sql/schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  const pool = getPool();
  await pool.query(schema);
}

export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}
