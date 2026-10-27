import { z } from 'zod';

export const MAX_QUANTITY = 10000;

export const ResourceType = z.enum(['food', 'water', 'medicine', 'shelter']);
export const Urgency = z.enum(['low', 'medium', 'high', 'critical']);
export const RequestStatus = z.enum(['pending', 'in_progress', 'resolved']);

export const ReliefRequestInput = z.strictObject({
  resource_type: ResourceType,
  quantity: z.int().min(1).max(MAX_QUANTITY),
  location: z.string().min(1).max(500),
  urgency: Urgency,
});

export const ReliefStatusPatch = z.strictObject({
  status: RequestStatus,
  expected_version: z.int().min(1),
});

export const ReliefRequest = z.object({
  id: z.uuid(),
  resource_type: ResourceType,
  quantity: z.int().min(1).max(MAX_QUANTITY),
  location: z.string().min(1).max(500),
  urgency: Urgency,
  status: RequestStatus,
  version: z.int().min(1),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});

export type ReliefRequestInput = z.infer<typeof ReliefRequestInput>;
export type ReliefStatusPatch = z.infer<typeof ReliefStatusPatch>;
export type ReliefRequest = z.infer<typeof ReliefRequest>;
export type RequestStatus = z.infer<typeof RequestStatus>;

const ALLOWED: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  pending: ['in_progress'],
  in_progress: ['resolved', 'pending'],
  resolved: ['in_progress'],
};

/** docs/05 transition table; same-status and pending->resolved are rejected. */
export const isAllowedStatusTransition = (from: RequestStatus, to: RequestStatus): boolean =>
  ALLOWED[from].includes(to);
