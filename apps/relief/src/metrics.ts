import client from 'prom-client';

export interface Metrics {
  registry: client.Registry;
  requests: client.Counter<'method' | 'route' | 'status'>;
  duration: client.Histogram<'method' | 'route'>;
  writesBlocked: client.Counter<'code'>;
}

/** No credentials or business record content in labels (docs/06). */
export function createMetrics(instanceId: string, appVersion: string, workload?: { inProgress: number; queued: number }): Metrics {
  const registry = new client.Registry();
  registry.setDefaultLabels({ instance_id: instanceId });
  client.collectDefaultMetrics({ register: registry });
  new client.Gauge({ name: 'relief_app_info', help: 'Build info', labelNames: ['version'], registers: [registry] }).set(
    { version: appVersion },
    1,
  );
  if (workload) {
    new client.Gauge({
      name: 'relief_demo_work_in_progress',
      help: 'Demo work items running',
      registers: [registry],
      collect() {
        this.set(workload.inProgress);
      },
    });
    new client.Gauge({
      name: 'relief_demo_work_queued',
      help: 'Demo work items waiting',
      registers: [registry],
      collect() {
        this.set(workload.queued);
      },
    });
  }
  return {
    registry,
    requests: new client.Counter({
      name: 'relief_http_requests_total',
      help: 'HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    duration: new client.Histogram({
      name: 'relief_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    writesBlocked: new client.Counter({
      name: 'relief_writes_blocked_total',
      help: 'Writes refused by maintenance admission',
      labelNames: ['code'],
      registers: [registry],
    }),
  };
}
