import { Worker } from 'node:worker_threads';

// Plain CommonJS source so the worker runs the same under tsx, node and a compiled image.
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { createHash } = require('node:crypto');
parentPort.on('message', ({ id, workMs }) => {
  const start = performance.now();
  let digest = Buffer.alloc(32);
  let iterations = 0;
  while (performance.now() - start < workMs) {
    digest = createHash('sha256').update(digest).digest();
    iterations++;
  }
  parentPort.postMessage({ id, iterations, elapsedMs: performance.now() - start });
});
`;

export interface WorkResult {
  iterations: number;
  elapsedMs: number;
}

export class QueueFullError extends Error {}

interface Job {
  id: number;
  workMs: number;
  resolve: (r: WorkResult) => void;
  reject: (e: Error) => void;
}

/**
 * Bounded CPU pool (docs/03 demo.max_cpu_workers_per_instance, max_queued_work_items). CPU work
 * never runs on the event loop, so /health/live stays responsive under load.
 */
export class WorkloadPool {
  private readonly idle: Worker[] = [];
  private readonly busy = new Map<Worker, Job>();
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly size: number,
    private readonly maxQueued: number,
  ) {
    for (let i = 0; i < size; i++) this.idle.push(this.spawn());
  }

  get inProgress(): number {
    return this.busy.size;
  }

  get queued(): number {
    return this.queue.length;
  }

  run(workMs: number): Promise<WorkResult> {
    if (this.closed) return Promise.reject(new Error('workload pool closed'));
    if (this.idle.length === 0 && this.queue.length >= this.maxQueued) {
      return Promise.reject(new QueueFullError('work queue full'));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, workMs, resolve, reject });
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) job.reject(new Error('workload pool closed'));
    const all = [...this.idle, ...this.busy.keys()];
    this.idle.length = 0;
    await Promise.all(all.map((w) => w.terminate()));
  }

  private dispatch(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.busy.set(worker, job);
      worker.postMessage({ id: job.id, workMs: job.workMs });
    }
  }

  private spawn(): Worker {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.unref();
    worker.on('message', (msg: { iterations: number; elapsedMs: number }) => {
      const job = this.busy.get(worker);
      this.busy.delete(worker);
      if (!this.closed) this.idle.push(worker);
      job?.resolve({ iterations: msg.iterations, elapsedMs: msg.elapsedMs });
      this.dispatch();
    });
    const replace = (err: Error) => {
      const job = this.busy.get(worker);
      this.busy.delete(worker);
      const i = this.idle.indexOf(worker);
      if (i >= 0) this.idle.splice(i, 1);
      job?.reject(err);
      if (!this.closed) {
        this.idle.push(this.spawn());
        this.dispatch();
      }
    };
    worker.on('error', replace);
    worker.on('exit', (code) => {
      if (!this.closed && (this.busy.has(worker) || this.idle.includes(worker))) replace(new Error(`worker exited (${code})`));
    });
    return worker;
  }
}
