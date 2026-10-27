// REAL local Postgres (TEST_DATABASE_URL), not Supabase. The app connects as a login role that is
// only a member of dr_app_runtime, so the grant model is exercised too. Covers T02, T19, T25.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@drproj/migrations';
import { assertWritable, createApp, createMetrics, createMetricsApp, loadConfig, purgeExpiredKeys, WorkloadPool } from '@drproj/relief';

const url = process.env['TEST_DATABASE_URL'];
const RUNTIME_USER = 'relief_runtime_test';
const RUNTIME_PW = 'test-only-runtime-password';

interface Running {
  base: string;
  close: () => Promise<void>;
  pool: pg.Pool;
}

async function start(env: Record<string, string> = {}): Promise<Running> {
  const u = new URL(url!);
  u.username = RUNTIME_USER;
  u.password = RUNTIME_PW;
  const config = loadConfig({ SUPABASE_APP_URL: u.toString(), INSTANCE_ID: 'test-1', APP_VERSION: 't', RATE_LIMITS_ENABLED: 'false', APP_DB_POOL_MAX: '4', ...env });
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  const workload = config.demo.enabled ? new WorkloadPool(1, 2) : null;
  const webDir = env['APP_WEB_DIR'];
  const metrics = createMetrics(config.instanceId, config.appVersion, workload ?? undefined);
  const server = http.createServer(createApp({ config, pool, metrics, workload, webDir }));
  const msrv = http.createServer(createMetricsApp(metrics));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => msrv.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    pool,
    close: async () => {
      await new Promise((r) => server.close(r));
      await new Promise((r) => msrv.close(r));
      await workload?.close();
      await pool.end();
    },
    // metrics base exposed via property below
    ...{ metricsBase: `http://127.0.0.1:${(msrv.address() as AddressInfo).port}` },
  } as Running & { metricsBase: string };
}

const valid = { resource_type: 'water', quantity: 100, location: 'Camp A', urgency: 'high' };
let keySeq = 0;
const newKey = () => `test-key-${Date.now()}-${++keySeq}`;

const post = (base: string, body: unknown, key: string | null = newKey(), headers: Record<string, string> = {}) =>
  fetch(`${base}/api/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const patch = (base: string, id: string, body: unknown, key = newKey()) =>
  fetch(`${base}/api/requests/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });

describe.skipIf(!url)('relief API (real Postgres)', () => {
  let admin: pg.Client;
  let app: Running & { metricsBase: string };
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await q('DROP SCHEMA IF EXISTS app CASCADE');
    await q('DROP SCHEMA IF EXISTS ops CASCADE');
    await runMigrations({ connectionString: url! });
    await q(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNTIME_USER}') THEN
        CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD '${RUNTIME_PW}';
      END IF; END $$`);
    await q(`ALTER ROLE ${RUNTIME_USER} PASSWORD '${RUNTIME_PW}'`);
    await q(`GRANT dr_app_runtime TO ${RUNTIME_USER}`);
    app = (await start()) as Running & { metricsBase: string };
  });

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await q('UPDATE ops.runtime_flags SET maintenance = false');
    await q('GRANT EXECUTE ON FUNCTION ops.app_maintenance_state() TO dr_app_runtime');
    await q('GRANT EXECUTE ON FUNCTION ops.app_admit_write() TO dr_app_runtime');
  });

  it('health: live needs no database; ready checks schema and control state; identity headers set', async () => {
    const live = await fetch(`${app.base}/health/live`);
    expect(live.status).toBe(200);
    expect(live.headers.get('x-instance-id')).toBe('test-1');
    expect(live.headers.get('x-content-type-options')).toBe('nosniff');
    const ready = await fetch(`${app.base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', maintenance: false, maintenance_generation: expect.any(Number) });

    const down = await start({ SUPABASE_APP_URL: 'postgres://nobody:x@127.0.0.1:1/none' });
    try {
      expect((await fetch(`${down.base}/health/live`)).status).toBe(200);
      const r = await fetch(`${down.base}/health/ready`);
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
      const w = await post(down.base, valid);
      expect(w.status).toBe(503);
      const text = await w.text();
      expect(text).not.toContain('nobody');
    } finally {
      await down.close();
    }
  });

  it('T02: parallel identical submissions create one record; replays are marked; changed body is rejected', async () => {
    const key = newKey();
    const before = (await q('SELECT count(*)::int AS n FROM app.relief_requests')).rows[0].n;
    const results = await Promise.all(Array.from({ length: 10 }, () => post(app.base, valid, key)));
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 201)).toBe(true);
    const bodies = await Promise.all(results.map((r) => r.json() as Promise<{ id: string }>));
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect(results.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(9);
    expect((await q('SELECT count(*)::int AS n FROM app.relief_requests')).rows[0].n).toBe(before + 1);

    const reordered = await post(app.base, { urgency: 'high', location: 'Camp A', quantity: 100, resource_type: 'water' }, key);
    expect(reordered.status).toBe(201);
    expect(reordered.headers.get('idempotent-replayed')).toBe('true');

    const changed = await post(app.base, { ...valid, quantity: 101 }, key);
    expect(changed.status).toBe(422);
    expect(await changed.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('T02: a key held by an uncommitted request returns 409 IN_FLIGHT after the 2 s lock wait', async () => {
    const key = newKey();
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO app.idempotency_records (key, method, route_template, request_hash, expires_at)
         VALUES ($1, 'POST', '/api/requests', 'x', now() + interval '1 hour')`,
        [key],
      );
      const t0 = Date.now();
      const r = await post(app.base, valid, key);
      expect(r.status).toBe(409);
      expect(r.headers.get('retry-after')).toBe('2');
      expect(await r.json()).toMatchObject({ code: 'IDEMPOTENCY_IN_FLIGHT' });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1900);
    } finally {
      await holder.query('ROLLBACK');
      await holder.end();
    }
    expect((await post(app.base, valid, key)).status).toBe(201);
  });

  it('T02: an expired key is taken over by a new request', async () => {
    const key = newKey();
    const first = (await (await post(app.base, valid, key)).json()) as { id: string };
    await q(`UPDATE app.idempotency_records SET expires_at = now() - interval '1 second' WHERE key = $1`, [key]);
    const second = await post(app.base, { ...valid, quantity: 7 }, key);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBeNull();
    expect(((await second.json()) as { id: string }).id).not.toBe(first.id);
  });

  it('T19: maintenance blocks every write, including via a direct VM address; reads continue', async () => {
    const created = (await (await post(app.base, valid)).json()) as { id: string; version: number };
    await q('UPDATE ops.runtime_flags SET maintenance = true');
    for (const r of [
      await post(app.base, valid, newKey(), { host: '203.0.113.10:8443' }),
      await patch(app.base, created.id, { status: 'in_progress', expected_version: created.version }),
    ]) {
      expect(r.status).toBe(503);
      expect(r.headers.get('retry-after')).toBe('60');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('content-type')).toContain('application/problem+json');
      expect(await r.json()).toMatchObject({ code: 'MAINTENANCE_WRITES_BLOCKED' });
    }
    expect((await fetch(`${app.base}/api/requests/${created.id}`)).status).toBe(200);
    const m = await (await fetch(`${app.metricsBase}/metrics`)).text();
    expect(m).toMatch(/relief_writes_blocked_total\{code="MAINTENANCE_WRITES_BLOCKED",instance_id="test-1"\} [1-9]/);
  });

  it('T19: an unreadable maintenance flag fails closed', async () => {
    await q('REVOKE EXECUTE ON FUNCTION ops.app_admit_write() FROM dr_app_runtime');
    const r = await post(app.base, valid);
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('60');
    expect(await r.json()).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('T19: a flag flip that commits while a write is waiting rejects the write', async () => {
    const before = (await q('SELECT count(*)::int AS n FROM app.relief_requests')).rows[0].n;
    const flipper = new pg.Client({ connectionString: url });
    await flipper.connect();
    try {
      await flipper.query('BEGIN');
      await flipper.query('UPDATE ops.runtime_flags SET maintenance = true, generation = generation + 1');
      const pending = post(app.base, valid); // blocks on the uncommitted flip (FOR SHARE)
      await new Promise((r) => setTimeout(r, 200));
      await flipper.query('COMMIT');
      const r = await pending;
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ code: 'MAINTENANCE_WRITES_BLOCKED' });
    } finally {
      await flipper.query('ROLLBACK').catch(() => undefined);
      await flipper.end();
    }
    expect((await q('SELECT count(*)::int AS n FROM app.relief_requests')).rows[0].n).toBe(before);
    const gen = (await (await fetch(`${app.base}/health/ready`)).json()) as { maintenance: boolean; maintenance_generation: number };
    expect(gen).toMatchObject({ maintenance: true });
    expect(gen.maintenance_generation).toBeGreaterThanOrEqual(1);
  });

  it('a flag flip waits for an in-flight write transaction to commit (drain)', async () => {
    const writer = await app.pool.connect();
    try {
      await writer.query('BEGIN');
      await assertWritable(writer, 60);
      const flip = new pg.Client({ connectionString: url });
      await flip.connect();
      await flip.query("SET lock_timeout = '300ms'");
      await expect(flip.query('UPDATE ops.runtime_flags SET maintenance = true')).rejects.toMatchObject({ code: '55P03' });
      await flip.end();
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });

  it('rejects an oversized body of any content type with 413', async () => {
    const r = await fetch(`${app.base}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'idempotency-key': newKey() },
      body: 'x'.repeat(9000),
    });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('background key purge honors maintenance', async () => {
    const key = newKey();
    await post(app.base, valid, key);
    await q(`UPDATE app.idempotency_records SET expires_at = now() - interval '1 second' WHERE key = $1`, [key]);
    const count = async () => (await q('SELECT count(*)::int AS n FROM app.idempotency_records WHERE key = $1', [key])).rows[0].n;
    await q('UPDATE ops.runtime_flags SET maintenance = true');
    expect(await purgeExpiredKeys(app.pool, 60)).toBe(0);
    expect(await count()).toBe(1);
    await q('UPDATE ops.runtime_flags SET maintenance = false');
    expect(await purgeExpiredKeys(app.pool, 60)).toBeGreaterThanOrEqual(1);
    expect(await count()).toBe(0);
  });

  it('T25: status transitions, version conflicts, history and 404/422 problems', async () => {
    const r0 = await post(app.base, valid);
    const c = (await r0.json()) as { id: string; version: number; status: string };
    expect(c).toMatchObject({ status: 'pending', version: 1 });

    const bad = await patch(app.base, c.id, { status: 'resolved', expected_version: 1 });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });

    const ok = await patch(app.base, c.id, { status: 'in_progress', expected_version: 1 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: 'in_progress', version: 2 });

    const stale = await patch(app.base, c.id, { status: 'resolved', expected_version: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    expect((await patch(app.base, c.id, { status: 'resolved', expected_version: 2 })).status).toBe(200);
    expect((await patch(app.base, c.id, { status: 'in_progress', expected_version: 3 })).status).toBe(200);

    const detail = (await (await fetch(`${app.base}/api/requests/${c.id}`)).json()) as {
      version: number;
      history: { old_status: string | null; new_status: string }[];
    };
    expect(detail.version).toBe(4);
    expect(detail.history.map((h) => [h.old_status, h.new_status])).toEqual([
      [null, 'pending'],
      ['pending', 'in_progress'],
      ['in_progress', 'resolved'],
      ['resolved', 'in_progress'],
    ]);

    for (const id of ['00000000-0000-4000-8000-999999999999', 'not-a-uuid']) {
      const nf = await fetch(`${app.base}/api/requests/${id}`);
      expect(nf.status).toBe(404);
      expect(nf.headers.get('content-type')).toContain('application/problem+json');
      expect(await nf.json()).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }
    expect((await patch(app.base, '00000000-0000-4000-8000-999999999999', { status: 'in_progress', expected_version: 1 })).status).toBe(404);
  });

  it('T25: list paginates without gaps or duplicates and filters', async () => {
    await q('TRUNCATE app.request_updates, app.relief_requests, app.idempotency_records');
    const kinds = ['food', 'water', 'medicine', 'shelter'] as const;
    for (let i = 0; i < 9; i++) {
      await post(app.base, { ...valid, resource_type: kinds[i % 4], urgency: i % 2 ? 'low' : 'critical' });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const u: string = `${app.base}/api/requests?limit=4${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await (await fetch(u)).json()) as { items: { id: string }[]; next_cursor: string | null };
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(9);

    const food = (await (await fetch(`${app.base}/api/requests?resource_type=food&urgency=critical`)).json()) as {
      items: { resource_type: string; urgency: string }[];
    };
    expect(food.items.length).toBe(3); // i = 0, 4, 8
    expect(food.items.every((i) => i.resource_type === 'food' && i.urgency === 'critical')).toBe(true);

    for (const bad of ['limit=0', 'limit=101', 'status=done', 'cursor=garbage']) {
      expect((await fetch(`${app.base}/api/requests?${bad}`)).status).toBe(400);
    }
  });

  it('validation limits: quantity max, 8 KB body, Idempotency-Key, unknown fields, malformed JSON', async () => {
    expect((await post(app.base, { ...valid, quantity: 10001 })).status).toBe(400);
    expect((await post(app.base, { ...valid, extra: 1 })).status).toBe(400);
    expect((await post(app.base, valid, null)).status).toBe(400);
    expect((await post(app.base, valid, 'short')).status).toBe(400);
    expect((await post(app.base, '{"oops"')).status).toBe(400);
    const big = await post(app.base, { ...valid, location: 'x'.repeat(9000) });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('demo workload: disabled by default; when enabled it runs bounded work and is rate limited per IP', async () => {
    const off = await fetch(`${app.base}/api/demo/workload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ code: 'DEMO_MODE_DISABLED' });

    const on = await start({ DEMO_MODE: 'true', RATE_LIMITS_ENABLED: 'true' });
    const exempt = await start({ DEMO_MODE: 'true', RATE_LIMITS_ENABLED: 'true', RATE_LIMIT_EXEMPT_IPS: '127.0.0.1' });
    try {
      const run = (base: string, body: unknown) =>
        fetch(`${base}/api/demo/workload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const r = await run(on.base, { work_ms: 20 });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ work_ms: 20, instance_id: 'test-1' });
      expect((await run(on.base, { work_ms: 251 })).status).toBe(400);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await run(on.base, { work_ms: 1 })).status);
      expect(statuses.at(-1)).toBe(429);
      const limited = await run(on.base, { work_ms: 1 });
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

      for (let i = 0; i < 7; i++) expect((await run(exempt.base, { work_ms: 1 })).status).toBe(200);
    } finally {
      await on.close();
      await exempt.close();
    }
  });

  it('serves the built UI with a page CSP; API and health paths never fall through to it', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'web-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
    const ui = await start({ APP_WEB_DIR: dir });
    try {
      for (const path of ['/', '/requests/anything']) {
        const r = await fetch(`${ui.base}${path}`);
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toContain('text/html');
        expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
      }
      const asset = await fetch(`${ui.base}/assets/app-abc.js`);
      expect(asset.headers.get('cache-control')).toContain('immutable');
      expect((await fetch(`${ui.base}/assets/missing.js`)).status).toBe(404);
      const api404 = await fetch(`${ui.base}/api/nope`);
      expect(api404.status).toBe(404);
      expect(api404.headers.get('content-type')).toContain('application/problem+json');
    } finally {
      await ui.close();
    }
  });
});
