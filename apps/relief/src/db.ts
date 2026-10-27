import pg from 'pg';

// Timestamps keep microseconds and UTC so list cursors stay exact (JS Date would drop them).
export const ts = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export function createPool(connectionString: string, max: number): pg.Pool {
  // Session pooler only, bounded, and no named prepared statements (we never pass `name`).
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'drproj-relief',
  });
  // An idle client error (e.g. Supabase restart) must not crash the process.
  pool.on('error', () => undefined);
  return pool;
}

export async function inTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
