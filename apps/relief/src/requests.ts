import type pg from 'pg';
import {
  isAllowedStatusTransition,
  type ReliefRequest,
  type ReliefRequestInput,
  type RequestStatus,
} from '@drproj/contracts';
import { ts } from './db.js';
import { Code, HttpProblem } from './problem.js';

export const UPDATE_SOURCE = 'relief_api';

const COLUMNS = `id, resource_type, quantity, location, urgency, status, version,
  ${ts('created_at')} AS created_at, ${ts('updated_at')} AS updated_at`;

export interface RequestUpdate {
  id: string;
  request_id: string;
  old_status: RequestStatus | null;
  new_status: RequestStatus;
  changed_at: string;
  source: string;
}

export interface ListFilter {
  limit: number;
  resource_type?: string | undefined;
  urgency?: string | undefined;
  status?: string | undefined;
  after?: { createdAt: string; id: string } | undefined;
}

export async function listRequests(db: pg.Pool, f: ListFilter): Promise<{ items: ReliefRequest[]; hasMore: boolean }> {
  const r = await db.query<ReliefRequest>(
    `SELECT ${COLUMNS} FROM app.relief_requests
     WHERE ($1::text IS NULL OR resource_type = $1)
       AND ($2::text IS NULL OR urgency = $2)
       AND ($3::text IS NULL OR status = $3)
       AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
     ORDER BY created_at DESC, id DESC
     LIMIT $6`,
    [f.resource_type ?? null, f.urgency ?? null, f.status ?? null, f.after?.createdAt ?? null, f.after?.id ?? null, f.limit + 1],
  );
  return { items: r.rows.slice(0, f.limit), hasMore: r.rows.length > f.limit };
}

export async function getRequest(db: pg.Pool, id: string): Promise<(ReliefRequest & { history: RequestUpdate[] }) | null> {
  const r = await db.query<ReliefRequest>(`SELECT ${COLUMNS} FROM app.relief_requests WHERE id = $1`, [id]);
  const request = r.rows[0];
  if (!request) return null;
  const h = await db.query<RequestUpdate>(
    `SELECT id, request_id, old_status, new_status, ${ts('changed_at')} AS changed_at, source
     FROM app.request_updates WHERE request_id = $1 ORDER BY changed_at, id`,
    [id],
  );
  return { ...request, history: h.rows };
}

export async function createRequest(c: pg.PoolClient, input: ReliefRequestInput): Promise<ReliefRequest> {
  const r = await c.query<ReliefRequest>(
    `INSERT INTO app.relief_requests (resource_type, quantity, location, urgency)
     VALUES ($1, $2, $3, $4) RETURNING ${COLUMNS}`,
    [input.resource_type, input.quantity, input.location, input.urgency],
  );
  const created = r.rows[0]!;
  await c.query(
    `INSERT INTO app.request_updates (request_id, old_status, new_status, source) VALUES ($1, NULL, $2, $3)`,
    [created.id, created.status, UPDATE_SOURCE],
  );
  return created;
}

export async function updateStatus(
  c: pg.PoolClient,
  id: string,
  to: RequestStatus,
  expectedVersion: number,
): Promise<ReliefRequest> {
  const cur = await c.query<{ status: RequestStatus; version: number }>(
    'SELECT status, version FROM app.relief_requests WHERE id = $1 FOR UPDATE',
    [id],
  );
  const row = cur.rows[0];
  if (!row) throw new HttpProblem(404, Code.NotFound, 'Relief request not found.');
  if (row.version !== expectedVersion) {
    throw new HttpProblem(409, Code.VersionConflict, `expected_version ${expectedVersion} is stale; current version is ${row.version}.`);
  }
  if (!isAllowedStatusTransition(row.status, to)) {
    throw new HttpProblem(422, Code.InvalidStatusTransition, `Transition ${row.status} -> ${to} is not allowed.`);
  }
  const r = await c.query<ReliefRequest>(
    `UPDATE app.relief_requests SET status = $2, version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, to],
  );
  await c.query(
    `INSERT INTO app.request_updates (request_id, old_status, new_status, source) VALUES ($1, $2, $3, $4)`,
    [id, row.status, to, UPDATE_SOURCE],
  );
  return r.rows[0]!;
}
