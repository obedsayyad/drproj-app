import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createApp, createMetricsApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { purgeExpiredKeys } from './idempotency.js';
import { createMetrics } from './metrics.js';
import { WorkloadPool } from './workload.js';

const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: 'info', msg, ...extra }));

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.dbPoolMax);
const workload = config.demo.enabled ? new WorkloadPool(config.demo.maxWorkers, config.demo.maxQueued) : null;
const metrics = createMetrics(config.instanceId, config.appVersion, workload ?? undefined);
const app = createApp({ config, pool, metrics, workload, webDir: config.webDir });

const server = config.tls
  ? https.createServer({ cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) }, app)
  : http.createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 65_000;
server.listen(config.port, () =>
  log('relief listening', { port: config.port, tls: Boolean(config.tls), instance_id: config.instanceId, version: config.appVersion }),
);
if (!config.tls) log('WARNING: plaintext HTTP; set APP_TLS_CERT_FILE/APP_TLS_KEY_FILE outside local development');

const metricsServer = http.createServer(createMetricsApp(metrics)).listen(config.metricsPort, () =>
  log('metrics listening', { port: config.metricsPort }),
);

const purge = setInterval(() => {
  purgeExpiredKeys(pool, config.maintenanceRetryAfterSeconds).catch(() => undefined);
}, 10 * 60_000);
purge.unref();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log('shutting down', { signal });
  clearInterval(purge);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  await Promise.all([
    new Promise((r) => server.close(r)),
    new Promise((r) => metricsServer.close(r)),
  ]);
  await workload?.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
