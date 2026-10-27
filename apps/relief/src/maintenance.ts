import type pg from 'pg';
import { Code, HttpProblem } from './problem.js';

/**
 * Fail-closed write admission (docs/06, T19). Runs inside the write transaction, on every write
 * path, whatever Host or address the request used. Never cached. The flag row is read FOR SHARE
 * (ops.app_admit_write), so it cannot flip between this check and the commit of the write: a flip
 * waits for us, or we wait for it and then see the committed value.
 */
export async function assertWritable(client: pg.PoolClient, retryAfterSeconds: number): Promise<void> {
  const headers = { 'Retry-After': String(retryAfterSeconds), 'Cache-Control': 'no-store' };
  let maintenance: unknown;
  try {
    await client.query("SET LOCAL lock_timeout = '2s'");
    const r = await client.query<{ maintenance: boolean }>('SELECT maintenance FROM ops.app_admit_write()');
    await client.query('RESET lock_timeout');
    maintenance = r.rows[0]?.maintenance;
  } catch {
    maintenance = undefined;
  }
  if (typeof maintenance !== 'boolean') {
    throw new HttpProblem(503, Code.DependencyUnavailable, 'Maintenance state is unreadable; writes are blocked.', headers);
  }
  if (maintenance) {
    throw new HttpProblem(503, Code.MaintenanceWritesBlocked, 'Maintenance is in progress; writes are blocked.', headers);
  }
}
