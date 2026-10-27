import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { canonicalJson, requestHash } from './idempotency.js';
import { clientIp, FixedWindowLimiter } from './rate-limit.js';
import { QueueFullError, WorkloadPool } from './workload.js';

describe('request hash', () => {
  it('ignores key order but not values, path or method', () => {
    const a = requestHash('POST', '/api/requests', { quantity: 5, urgency: 'low' });
    expect(requestHash('POST', '/api/requests', { urgency: 'low', quantity: 5 })).toBe(a);
    expect(requestHash('POST', '/api/requests', { urgency: 'low', quantity: 6 })).not.toBe(a);
    expect(requestHash('PATCH', '/api/requests', { urgency: 'low', quantity: 5 })).not.toBe(a);
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });
});

describe('cursor', () => {
  it('round-trips and rejects foreign input', () => {
    const pos = { createdAt: '2026-10-01T06:00:00.123456Z', id: '00000000-0000-4000-8000-000000000001' };
    expect(decodeCursor(encodeCursor(pos))).toEqual(pos);
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(Buffer.from('["x","y"]').toString('base64url'))).toBeNull();
  });
});

describe('rate limiter', () => {
  it('allows the limit per window, then reports seconds to reset', () => {
    const l = new FixedWindowLimiter(2, 10_000);
    expect([l.hit('a', 0), l.hit('a', 1), l.hit('b', 1)]).toEqual([0, 0, 0]);
    expect(l.hit('a', 2_000)).toBe(8);
    expect(l.hit('a', 10_000)).toBe(0);
  });
  it('stays bounded under many distinct keys', () => {
    const l = new FixedWindowLimiter(1, 10_000, 3);
    for (const k of ['a', 'b', 'c', 'd', 'e']) l.hit(k, 0);
    expect((l as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(3);
  });
  it('trusts X-Forwarded-For only from configured proxies', () => {
    expect(clientIp('::ffff:10.0.0.5', '1.2.3.4', ['10.0.0.5'])).toBe('1.2.3.4');
    expect(clientIp('10.0.0.6', '1.2.3.4', ['10.0.0.5'])).toBe('10.0.0.6');
    expect(clientIp('10.0.0.5', 'spoofed, 5.6.7.8', ['10.0.0.5'])).toBe('5.6.7.8');
  });
});

describe('config', () => {
  it('requires the database URL and never echoes values', () => {
    expect(() => loadConfig({ SUPABASE_APP_URL: '', INSTANCE_ID: 'x' })).toThrow(/SUPABASE_APP_URL/);
    expect(() => loadConfig({ SUPABASE_APP_URL: 'postgres://u:SECRET@h/db', APP_TLS_CERT_FILE: '/c' })).toThrow(/together/);
    try {
      loadConfig({ SUPABASE_APP_URL: 'postgres://u:SECRET@h/db', APP_PORT: 'nope' });
    } catch (e) {
      expect(String(e)).not.toContain('SECRET');
    }
    const c = loadConfig({ SUPABASE_APP_URL: 'postgres://h/db', RATE_LIMIT_EXEMPT_IPS: '1.2.3.4, 5.6.7.8' });
    expect(c.rateLimit.exemptIps).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(c.dbPoolMax).toBe(2);
    expect(c.demo.enabled).toBe(false);
  });

  it('refuses APP_DB_POOL_MAX outside 1..5 instead of adjusting it', () => {
    const base = { SUPABASE_APP_URL: 'postgres://h/db' };
    for (const bad of ['0', '6', '9', '-1', '2.5']) {
      expect(() => loadConfig({ ...base, APP_DB_POOL_MAX: bad })).toThrow(/APP_DB_POOL_MAX/);
    }
    expect(loadConfig({ ...base, APP_DB_POOL_MAX: '5' }).dbPoolMax).toBe(5);
    expect(loadConfig({ ...base, APP_DB_POOL_MAX: '1' }).dbPoolMax).toBe(1);
  });
});

describe('workload pool', () => {
  it('bounds the queue and keeps the event loop free', async () => {
    const pool = new WorkloadPool(1, 1);
    try {
      const first = pool.run(150);
      const second = pool.run(10);
      await expect(pool.run(10)).rejects.toBeInstanceOf(QueueFullError);
      // Event loop is not blocked by the 150 ms CPU job.
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 5));
      expect(performance.now() - t0).toBeLessThan(100);
      const r = await first;
      expect(r.elapsedMs).toBeGreaterThanOrEqual(150);
      await second;
    } finally {
      await pool.close();
    }
  });
});
