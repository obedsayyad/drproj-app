import type { ReliefRequest, ReliefRequestInput, RequestStatus } from '@drproj/contracts';

export type { ReliefRequest, ReliefRequestInput, RequestStatus };

export interface RequestUpdate {
  id: string;
  old_status: RequestStatus | null;
  new_status: RequestStatus;
  changed_at: string;
  source: string;
}
export type ReliefRequestDetail = ReliefRequest & { history: RequestUpdate[] };
export interface Page {
  items: ReliefRequest[];
  next_cursor: string | null;
}
export interface Filters {
  resource_type?: string;
  urgency?: string;
  status?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter: number | null,
  ) {
    super(message);
  }
}

type Listener = (instanceId: string) => void;
const listeners = new Set<Listener>();
/** Every response names the server that answered (X-Instance-Id). */
export const onInstance = (l: Listener) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { accept: 'application/json', ...init.headers } });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.', null);
  }
  const instance = res.headers.get('x-instance-id');
  if (instance) listeners.forEach((l) => l(instance));
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const p = (body ?? {}) as { code?: string; detail?: string; title?: string };
    const ra = res.headers.get('retry-after');
    throw new ApiError(res.status, p.code ?? 'HTTP_ERROR', p.detail ?? p.title ?? `Request failed (${res.status}).`, ra ? Number(ra) : null);
  }
  return body as T;
}

export const ping = () => call<{ instance_id: string }>('/health/live');

export function listRequests(filters: Filters, cursor?: string | null): Promise<Page> {
  const q = new URLSearchParams({ limit: '20' });
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  if (cursor) q.set('cursor', cursor);
  return call(`/api/requests?${q}`);
}

export const getRequest = (id: string) => call<ReliefRequestDetail>(`/api/requests/${id}`);

const json = (method: string, key: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json', 'idempotency-key': key },
  body: JSON.stringify(body),
});

export const createRequest = (input: ReliefRequestInput, key: string) =>
  call<ReliefRequest>('/api/requests', json('POST', key, input));

export const updateStatus = (id: string, status: RequestStatus, expectedVersion: number, key: string) =>
  call<ReliefRequest>(`/api/requests/${id}`, json('PATCH', key, { status, expected_version: expectedVersion }));

export const newKey = () => crypto.randomUUID();
