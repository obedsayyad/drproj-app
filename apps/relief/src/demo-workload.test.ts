import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createMetrics } from './metrics.js';
import { WorkloadPool } from './workload.js';

// The demo workload is CPU-only, so it is exempt from maintenance admission (docs/06). Prove it
// never touches the database: any pool access is counted and fails the request.
describe('POST /api/demo/workload', () => {
  it('never acquires a database connection', async () => {
    let touched = 0;
    const fail = async () => {
      touched++;
      throw new Error('db touched');
    };
    const pool = { connect: fail, query: fail } as unknown as pg.Pool;
    const config = loadConfig({ SUPABASE_APP_URL: 'postgres://h/db', DEMO_MODE: 'true' });
    const workload = new WorkloadPool(1, 1);
    const server = http.createServer(createApp({ config, pool, metrics: createMetrics('t', 'v'), workload }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/demo/workload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ work_ms: 5 }),
      });
      expect(res.status).toBe(200);
      expect(touched).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
      await workload.close();
    }
  });
});
