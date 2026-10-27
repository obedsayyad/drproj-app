import type { RequestStatus } from './api';

export const RESOURCES = [
  ['food', 'Food'],
  ['water', 'Water'],
  ['medicine', 'Medicine'],
  ['shelter', 'Shelter'],
] as const;
export const URGENCIES = [
  ['critical', 'Critical'],
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
] as const;
export const STATUSES = [
  ['pending', 'Waiting'],
  ['in_progress', 'In progress'],
  ['resolved', 'Resolved'],
] as const;

const find = (list: readonly (readonly [string, string])[], v: string) => list.find(([k]) => k === v)?.[1] ?? v;
export const resourceLabel = (v: string) => find(RESOURCES, v);
export const urgencyLabel = (v: string) => find(URGENCIES, v);
export const statusLabel = (v: string) => find(STATUSES, v);

/** Button wording per allowed transition (docs/05). */
export const ACTIONS: Record<RequestStatus, { to: RequestStatus; label: string }[]> = {
  pending: [{ to: 'in_progress', label: 'Start work' }],
  in_progress: [
    { to: 'resolved', label: 'Mark resolved' },
    { to: 'pending', label: 'Return to queue' },
  ],
  resolved: [{ to: 'in_progress', label: 'Reopen' }],
};

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function ago(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}
export const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
