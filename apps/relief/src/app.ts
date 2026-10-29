import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKey,
  ReliefRequestInput,
  ReliefStatusPatch,
  RequestStatus,
  ResourceType,
  Urgency,
} from '@drproj/contracts';
import type { Config } from './config.js';
import { decodeCursor, encodeCursor, isUuid } from './cursor.js';
import { inTransaction } from './db.js';
import { claimKey, requestHash, saveResponse, type KeyRef } from './idempotency.js';
import { assertWritable } from './maintenance.js';
import type { Metrics } from './metrics.js';
import { Code, HttpProblem, sendProblem } from './problem.js';
import { clientIp, FixedWindowLimiter } from './rate-limit.js';
import { createRequest, getRequest, listRequests, updateStatus } from './requests.js';
import { QueueFullError, type WorkloadPool } from './workload.js';

/** Last app migration this build needs; /health/ready fails until it is applied. */
export const REQUIRED_APP_MIGRATION = '0002_runtime_readiness_grant.sql';

export interface Deps {
  config: Config;
  pool: pg.Pool;
  metrics: Metrics;
  workload: WorkloadPool | null;
  /** Built UI (web/dist). Served when it contains index.html. */
  webDir?: string | undefined;
}

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  resource_type: ResourceType.optional(),
  urgency: Urgency.optional(),
  status: RequestStatus.optional(),
});

const fieldErrors = (e: z.ZodError) =>
  e.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message }));

const invalid = (e: z.ZodError) => new HttpProblem(400, Code.ValidationFailed, 'Request validation failed.', {}, fieldErrors(e));

const CONNECTION_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P03', '08000', '08001', '08003', '08006', '53300']);

function isDependencyError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string' && CONNECTION_ERRORS.has(e.code)) return true;
  return typeof e.message === 'string' && /timeout exceeded when trying to connect|Connection terminated/i.test(e.message);
}

const MAX_BODY_BYTES = 8 * 1024;

export function createApp({ config, pool, metrics, workload, webDir }: Deps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // Identity + security headers + metrics on every response, including errors.
  app.use((req, res, next) => {
    res.setHeader('X-Instance-Id', config.instanceId);
    const { role, provider, region, label } = config.instance;
    if (role) res.setHeader('X-Instance-Role', role);
    if (provider) res.setHeader('X-Instance-Provider', provider);
    if (region) res.setHeader('X-Instance-Region', encodeURIComponent(region));
    if (label) res.setHeader('X-Instance-Label', encodeURIComponent(label));
    res.setHeader('X-App-Version', config.appVersion);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Cache-Control', 'no-store');
    const end = metrics.duration.startTimer();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';
      metrics.requests.inc({ method: req.method, route, status: String(res.statusCode) });
      end({ method: req.method, route });
      if (res.statusCode === 503) {
        const code = res.getHeader('X-Problem-Code');
        if (code === Code.MaintenanceWritesBlocked || code === Code.DependencyUnavailable) {
          metrics.writesBlocked.inc({ code });
        }
      }
    });
    next();
  });

  app.get('/api/instance', (_req, res) => {
    res.json({ instance_id: config.instanceId, ...config.instance, version: config.appVersion });
  });

  // Liveness first: no database, no rate limit (HAProxy checks only this).
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', instance_id: config.instanceId, version: config.appVersion });
  });

  // Per-IP limits (docs/08): general 50/10 s, POST 20/10 s, demo 5/10 s; the test host is exempt.
  const general = new FixedWindowLimiter(50, 10_000);
  const writes = new FixedWindowLimiter(20, 10_000);
  const demo = new FixedWindowLimiter(5, 10_000);
  app.use((req, _res, next) => {
    if (!config.rateLimit.enabled) return next();
    const ip = clientIp(req.socket.remoteAddress, req.get('x-forwarded-for'), config.trustedProxyIps);
    if (config.rateLimit.exemptIps.includes(ip)) return next();
    const limiters = [general];
    if (req.method !== 'GET' && req.method !== 'HEAD') limiters.push(writes);
    if (req.path === '/api/demo/workload') limiters.push(demo);
    for (const l of limiters) {
      const wait = l.hit(ip);
      if (wait > 0) return next(new HttpProblem(429, Code.RateLimited, 'Rate limit exceeded.', { 'Retry-After': String(wait) }));
    }
    next();
  });

  // Body cap applies to every content type, not only JSON that express.json would read.
  app.use((req, _res, next) => {
    if (Number(req.get('content-length') ?? 0) > MAX_BODY_BYTES) {
      return next(new HttpProblem(413, Code.PayloadTooLarge, 'Request body exceeds 8 KB.'));
    }
    next();
  });
  app.use(express.json({ limit: '8kb', strict: true }));

  app.get('/health/ready', async (_req, res) => {
    let row: { schema_ok: boolean; maintenance: boolean | null; generation: string | null } | undefined;
    try {
      const r = await pool.query<{ schema_ok: boolean; maintenance: boolean | null; generation: string | null }>(
        `SELECT EXISTS (SELECT 1 FROM app.schema_migrations WHERE name = $1) AS schema_ok,
                s.maintenance, s.generation::text AS generation
         FROM (SELECT 1) AS one LEFT JOIN ops.app_maintenance_state() s ON true`,
        [REQUIRED_APP_MIGRATION],
      );
      row = r.rows[0];
    } catch {
      row = undefined;
    }
    if (!row) throw new HttpProblem(503, Code.DependencyUnavailable, 'Database or control state is unreachable.');
    if (!row.schema_ok) throw new HttpProblem(503, Code.SchemaIncompatible, `App schema lacks ${REQUIRED_APP_MIGRATION}.`);
    res.json({ status: 'ready', instance_id: config.instanceId, version: config.appVersion, maintenance: row.maintenance, maintenance_generation: row.generation === null ? null : Number(row.generation) });
  });

  app.get('/api/requests', async (req, res) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw invalid(q.error);
    const after = q.data.cursor === undefined ? undefined : decodeCursor(q.data.cursor);
    if (after === null) throw new HttpProblem(400, Code.ValidationFailed, 'Invalid cursor.', {}, [{ field: 'cursor', message: 'invalid' }]);
    const { items, hasMore } = await listRequests(pool, { ...q.data, after });
    const last = items.at(-1);
    res.json({ items, next_cursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null });
  });

  app.get('/api/requests/:id', async (req, res) => {
    const id = req.params['id'] ?? '';
    const found = isUuid(id) ? await getRequest(pool, id) : null;
    if (!found) throw new HttpProblem(404, Code.NotFound, 'Relief request not found.');
    res.json(found);
  });

  /** Maintenance admission + idempotent claim + business write + stored result, in one transaction. */
  async function idempotentWrite(
    req: Request,
    res: Response,
    routeTemplate: string,
    status: number,
    work: (c: pg.PoolClient) => Promise<object>,
  ): Promise<void> {
    const key = IdempotencyKey.safeParse(req.get(IDEMPOTENCY_KEY_HEADER));
    if (!key.success) {
      throw new HttpProblem(400, Code.ValidationFailed, 'Idempotency-Key header is missing or invalid.', {}, [
        { field: IDEMPOTENCY_KEY_HEADER, message: 'must match ^[A-Za-z0-9_-]{8,128}$' },
      ]);
    }
    const ref: KeyRef = { key: key.data, method: req.method, routeTemplate };
    const hash = requestHash(req.method, req.path, req.body);
    const out = await inTransaction(pool, async (c) => {
      await assertWritable(c, config.maintenanceRetryAfterSeconds);
      const claim = await claimKey(c, ref, hash, config.idempotencyRetentionHours);
      if (claim.kind === 'replay') return { status: claim.status, body: claim.body, replayed: true };
      const body = await work(c);
      await saveResponse(c, ref, status, body);
      return { status, body, replayed: false };
    });
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(out.status).json(out.body);
  }

  app.post('/api/requests', async (req, res) => {
    const input = ReliefRequestInput.safeParse(req.body);
    if (!input.success) throw invalid(input.error);
    await idempotentWrite(req, res, '/api/requests', 201, (c) => createRequest(c, input.data));
  });

  app.patch('/api/requests/:id', async (req, res) => {
    const id = req.params['id'] ?? '';
    const patch = ReliefStatusPatch.safeParse(req.body);
    if (!patch.success) throw invalid(patch.error);
    if (!isUuid(id)) throw new HttpProblem(404, Code.NotFound, 'Relief request not found.');
    await idempotentWrite(req, res, '/api/requests/{id}', 200, (c) =>
      updateStatus(c, id, patch.data.status, patch.data.expected_version),
    );
  });

  const DemoInput = z.strictObject({
    work_ms: z.int().min(1).max(config.demo.maxWorkMs).default(config.demo.defaultWorkMs),
  });

  app.post('/api/demo/workload', async (req, res) => {
    if (!config.demo.enabled || !workload) {
      throw new HttpProblem(503, Code.DemoModeDisabled, 'Demo workload is disabled (DEMO_MODE).');
    }
    const input = DemoInput.safeParse(req.body ?? {});
    if (!input.success) throw invalid(input.error);
    try {
      const r = await workload.run(input.data.work_ms);
      res.json({ work_ms: input.data.work_ms, elapsed_ms: Math.round(r.elapsedMs), iterations: r.iterations, instance_id: config.instanceId });
    } catch (err) {
      if (err instanceof QueueFullError) {
        throw new HttpProblem(503, Code.WorkQueueFull, 'Demo work queue is full.', { 'Retry-After': '1' });
      }
      throw err;
    }
  });

  // Built React UI (same origin as the API, so no CORS). API/health paths never fall through to it.
  const indexFile = webDir ? join(webDir, 'index.html') : null;
  if (webDir && indexFile && existsSync(indexFile)) {
    const indexHtml = readFileSync(indexFile);
    const PAGE_CSP =
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
    app.use(
      '/assets',
      express.static(join(webDir, 'assets'), {
        index: false,
        setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'),
      }),
    );
    app.get('/{*page}', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/health/') || req.path.startsWith('/assets/')) return next();
      res.setHeader('Content-Security-Policy', PAGE_CSP);
      res.setHeader('Cache-Control', 'no-cache');
      res.type('html').send(indexHtml);
    });
  }

  app.use((_req, _res, next) => next(new HttpProblem(404, Code.NotFound, 'No such route.')));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let p: HttpProblem;
    const type = (err as { type?: unknown }).type;
    if (err instanceof HttpProblem) p = err;
    else if (type === 'entity.too.large') p = new HttpProblem(413, Code.PayloadTooLarge, 'Request body exceeds 8 KB.');
    else if (type === 'entity.parse.failed' || type === 'encoding.unsupported' || type === 'charset.unsupported') {
      p = new HttpProblem(400, Code.ValidationFailed, 'Malformed request body.');
    } else if (isDependencyError(err)) {
      p = new HttpProblem(503, Code.DependencyUnavailable, 'Database is unavailable.', { 'Retry-After': '5' });
    } else {
      // Never echo internal error text: it can carry connection details.
      console.error(JSON.stringify({ level: 'error', msg: 'unhandled', path: req.path, error: (err as Error)?.name }));
      p = new HttpProblem(500, Code.InternalError, 'Unexpected error.');
    }
    res.setHeader('X-Problem-Code', p.code);
    sendProblem(res, p);
  });

  return app;
}

/** Diagnostics listener (not routed publicly by HAProxy). */
export function createMetricsApp(metrics: Metrics): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });
  return app;
}
