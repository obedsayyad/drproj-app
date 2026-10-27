/** Fixed-window per-key counter. In-memory per instance; HAProxy holds the shared limits. */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Returns 0 when allowed, otherwise seconds until the window resets (>= 1). */
  hit(key: string, now = Date.now()): number {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      if (!w && this.windows.size >= this.maxKeys) this.sweep(now);
      w = { start: now, count: 0 };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= this.limit) return 0;
    return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
  }

  sweep(now = Date.now()): void {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
    // Still full (flood of distinct keys): drop everything rather than grow without bound.
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}

const stripV4Mapped = (ip: string) => (ip.startsWith('::ffff:') ? ip.slice(7) : ip);

/** Client IP: the socket peer, or the last X-Forwarded-For hop when the peer is a trusted proxy. */
export function clientIp(socketIp: string | undefined, xff: string | undefined, trustedProxies: readonly string[]): string {
  const peer = stripV4Mapped(socketIp ?? 'unknown');
  if (xff && trustedProxies.includes(peer)) {
    const last = xff.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return stripV4Mapped(last);
  }
  return peer;
}
