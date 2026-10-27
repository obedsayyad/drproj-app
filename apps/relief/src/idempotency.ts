import { createHash } from 'node:crypto';
import type pg from 'pg';
import { inTransaction } from './db.js';
import { assertWritable } from './maintenance.js';
import { Code, HttpProblem } from './problem.js';

/** Stable JSON: object keys sorted recursively, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** docs/05: hash covers method, concrete path and canonical body. */
export const requestHash = (method: string, path: string, body: unknown): string =>
  createHash('sha256').update(`${method}\n${path}\n${canonicalJson(body)}`).digest('hex');

export interface KeyRef {
  key: string;
  method: string;
  routeTemplate: string;
}

export type Claim = { kind: 'claimed' } | { kind: 'replay'; status: number; body: unknown };

const LOCK_NOT_AVAILABLE = '55P03';

/** Claims the key in the caller's transaction (docs/05). Throws 409 in-flight or 422 reuse. */
export async function claimKey(
  client: pg.PoolClient,
  ref: KeyRef,
  hash: string,
  retentionHours: number,
): Promise<Claim> {
  await client.query("SET LOCAL lock_timeout = '2s'");
  let inserted: number;
  try {
    const r = await client.query(
      `INSERT INTO app.idempotency_records (key, method, route_template, request_hash, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(hours => $5))
       ON CONFLICT (method, route_template, key) DO UPDATE
         SET request_hash = EXCLUDED.request_hash, response_status = NULL, response_body = NULL,
             created_at = clock_timestamp(), expires_at = EXCLUDED.expires_at
         WHERE app.idempotency_records.expires_at <= clock_timestamp()
       RETURNING 1`,
      [ref.key, ref.method, ref.routeTemplate, hash, retentionHours],
    );
    inserted = r.rowCount ?? 0;
  } catch (err) {
    if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE) throw inFlight();
    throw err;
  }
  await client.query('RESET lock_timeout');
  if (inserted === 1) return { kind: 'claimed' };

  const existing = await client.query<{ request_hash: string; response_status: number | null; response_body: unknown }>(
    `SELECT request_hash, response_status, response_body FROM app.idempotency_records
     WHERE method = $1 AND route_template = $2 AND key = $3`,
    [ref.method, ref.routeTemplate, ref.key],
  );
  const row = existing.rows[0];
  if (!row || row.response_status === null) throw inFlight();
  if (row.request_hash !== hash) {
    throw new HttpProblem(422, Code.IdempotencyKeyReused, 'Idempotency-Key was already used with a different request.');
  }
  return { kind: 'replay', status: row.response_status, body: row.response_body };
}

export async function saveResponse(client: pg.PoolClient, ref: KeyRef, status: number, body: unknown): Promise<void> {
  await client.query(
    `UPDATE app.idempotency_records SET response_status = $4, response_body = $5
     WHERE method = $1 AND route_template = $2 AND key = $3`,
    [ref.method, ref.routeTemplate, ref.key, status, JSON.stringify(body)],
  );
}

const inFlight = () =>
  new HttpProblem(409, Code.IdempotencyInFlight, 'The original request with this Idempotency-Key is still in progress.', {
    'Retry-After': '2',
  });

/**
 * Background purge of completed, expired keys. A write, so it honors maintenance: when writes are
 * blocked or the flag is unreadable it does nothing. Returns rows deleted.
 */
export async function purgeExpiredKeys(pool: pg.Pool, retryAfterSeconds: number): Promise<number> {
  try {
    return await inTransaction(pool, async (c) => {
      await assertWritable(c, retryAfterSeconds);
      const r = await c.query(
        `DELETE FROM app.idempotency_records WHERE ctid IN (
           SELECT ctid FROM app.idempotency_records
           WHERE expires_at <= clock_timestamp() AND response_status IS NOT NULL
           LIMIT 500 FOR UPDATE SKIP LOCKED)`,
      );
      return r.rowCount ?? 0;
    });
  } catch (err) {
    if (err instanceof HttpProblem) return 0;
    throw err;
  }
}
