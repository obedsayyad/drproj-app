import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { discoverMigrations, planMigrations, TRACKS, type Track } from './plan.js';

const DEFAULT_SQL_DIR = fileURLToPath(new URL('../sql', import.meta.url));
// Arbitrary constant; serializes concurrent runners on one database (session-level lock).
const ADVISORY_LOCK_KEY = 727_001;

export interface RunOptions {
  connectionString: string;
  sqlDir?: string;
}

export interface RunResult {
  /** `track/name` for every file applied by this run. */
  applied: string[];
}

export async function runMigrations(opts: RunOptions): Promise<RunResult> {
  const sqlDir = opts.sqlDir ?? DEFAULT_SQL_DIR;
  // Bounded pool: one connection; the session advisory lock lives on it. Session pooler only.
  const pool = new pg.Pool({ connectionString: opts.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    for (const track of TRACKS) {
      applied.push(...(await runTrack(client, sqlDir, track)));
    }
    return { applied };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
      await pool.end();
    }
  }
}

async function runTrack(client: pg.PoolClient, sqlDir: string, track: Track): Promise<string[]> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${track}`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${track}.schema_migrations (
       name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
  );
  const rows = await client.query<{ name: string; checksum: string }>(
    `SELECT name, checksum FROM ${track}.schema_migrations`,
  );
  const files = await discoverMigrations(sqlDir, track);
  const plan = planMigrations(files, new Map(rows.rows.map((r) => [r.name, r.checksum])));
  if (plan.changed.length > 0) {
    throw new Error(`${track}: applied migration(s) modified: ${plan.changed.join(', ')}`);
  }
  if (plan.missing.length > 0) {
    throw new Error(`${track}: applied migration(s) missing on disk: ${plan.missing.join(', ')}`);
  }
  const done: string[] = [];
  for (const file of plan.pending) {
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`SET LOCAL statement_timeout = '60s'`);
      await client.query(file.sql);
      await client.query(`INSERT INTO ${track}.schema_migrations (name, checksum) VALUES ($1, $2)`, [
        file.name,
        file.checksum,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`${track}/${file.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    done.push(`${track}/${file.name}`);
  }
  return done;
}
