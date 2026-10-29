import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const MAX_DB_POOL = 5;
const bool = z.enum(['true', 'false', '1', '0', '']).transform((v) => v === 'true' || v === '1');
const csv = z.string().transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const Env = z.object({
  SUPABASE_APP_URL: z.string().min(1),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
  APP_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  APP_TLS_CERT_FILE: z.string().optional(),
  APP_TLS_KEY_FILE: z.string().optional(),
  // Policy runtime.app_db_pool_max is 1..5; larger values are clamped (warned), not rejected.
  APP_DB_POOL_MAX: z.coerce.number().int().default(2),
  INSTANCE_ID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).default('local'),
  // Display-only identity (docs/06): friendly name and place of this instance. No addresses, no secrets.
  INSTANCE_ROLE: z.enum(['primary', 'warm', 'elastic']).optional(),
  INSTANCE_PROVIDER: z.enum(['self_hosted', 'digitalocean', 'linode']).optional(),
  INSTANCE_REGION: z.string().regex(/^[\p{L}\p{N} ()._,-]{1,80}$/u).optional(),
  INSTANCE_LABEL: z.string().regex(/^[\p{L}\p{N} ()._,-]{1,48}$/u).optional(),
  APP_VERSION: z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/).default('dev'),
  DEMO_MODE: bool.default(false),
  DEMO_DEFAULT_WORK_MS: z.coerce.number().int().min(1).max(250).default(100),
  DEMO_MAX_WORK_MS: z.coerce.number().int().min(1).max(250).default(250),
  DEMO_MAX_CPU_WORKERS: z.coerce.number().int().min(1).max(4).default(1),
  DEMO_MAX_QUEUED_WORK_ITEMS: z.coerce.number().int().min(0).max(1000).default(32),
  MAINTENANCE_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).default(60),
  IDEMPOTENCY_RETENTION_HOURS: z.coerce.number().int().min(1).default(24),
  RATE_LIMIT_EXEMPT_IPS: csv.default([]),
  // Proxies whose X-Forwarded-For is trusted (the HAProxy VM). Empty = use the socket address.
  TRUSTED_PROXY_IPS: csv.default([]),
  RATE_LIMITS_ENABLED: bool.default(true),
  APP_WEB_DIR: z.string().optional(),
});

export interface Config {
  databaseUrl: string;
  port: number;
  metricsPort: number;
  tls: { certFile: string; keyFile: string } | null;
  dbPoolMax: number;
  instanceId: string;
  instance: { role: string | null; provider: string | null; region: string | null; label: string | null };
  appVersion: string;
  demo: { enabled: boolean; defaultWorkMs: number; maxWorkMs: number; maxWorkers: number; maxQueued: number };
  maintenanceRetryAfterSeconds: number;
  idempotencyRetentionHours: number;
  rateLimit: { enabled: boolean; exemptIps: string[] };
  trustedProxyIps: string[];
  webDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Names only; never echo values (they may be secrets).
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid or missing configuration: ${names}`);
  }
  const e = parsed.data;
  if (Boolean(e.APP_TLS_CERT_FILE) !== Boolean(e.APP_TLS_KEY_FILE)) {
    throw new Error('invalid configuration: APP_TLS_CERT_FILE and APP_TLS_KEY_FILE must be set together');
  }
  if (e.DEMO_DEFAULT_WORK_MS > e.DEMO_MAX_WORK_MS) {
    throw new Error('invalid configuration: DEMO_DEFAULT_WORK_MS exceeds DEMO_MAX_WORK_MS');
  }
  if (e.APP_DB_POOL_MAX < 1 || e.APP_DB_POOL_MAX > MAX_DB_POOL) {
    throw new Error(`invalid configuration: APP_DB_POOL_MAX must be an integer from 1 to ${MAX_DB_POOL}`);
  }
  return {
    databaseUrl: e.SUPABASE_APP_URL,
    port: e.APP_PORT,
    metricsPort: e.APP_METRICS_PORT,
    tls: e.APP_TLS_CERT_FILE && e.APP_TLS_KEY_FILE ? { certFile: e.APP_TLS_CERT_FILE, keyFile: e.APP_TLS_KEY_FILE } : null,
    dbPoolMax: e.APP_DB_POOL_MAX,
    instanceId: e.INSTANCE_ID,
    instance: { role: e.INSTANCE_ROLE ?? null, provider: e.INSTANCE_PROVIDER ?? null, region: e.INSTANCE_REGION ?? null, label: e.INSTANCE_LABEL ?? null },
    appVersion: e.APP_VERSION,
    demo: {
      enabled: e.DEMO_MODE,
      defaultWorkMs: e.DEMO_DEFAULT_WORK_MS,
      maxWorkMs: e.DEMO_MAX_WORK_MS,
      maxWorkers: e.DEMO_MAX_CPU_WORKERS,
      maxQueued: e.DEMO_MAX_QUEUED_WORK_ITEMS,
    },
    maintenanceRetryAfterSeconds: e.MAINTENANCE_RETRY_AFTER_SECONDS,
    idempotencyRetentionHours: e.IDEMPOTENCY_RETENTION_HOURS,
    rateLimit: { enabled: e.RATE_LIMITS_ENABLED, exemptIps: e.RATE_LIMIT_EXEMPT_IPS },
    trustedProxyIps: e.TRUSTED_PROXY_IPS,
    webDir: e.APP_WEB_DIR ?? fileURLToPath(new URL('../web/dist', import.meta.url)),
  };
}
