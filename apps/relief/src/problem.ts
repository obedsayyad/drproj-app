import type { Response } from 'express';
import { ProblemCode, type Problem } from '@drproj/contracts';

export const Code = {
  ...ProblemCode,
  ValidationFailed: 'VALIDATION_FAILED',
  NotFound: 'NOT_FOUND',
  VersionConflict: 'VERSION_CONFLICT',
  InvalidStatusTransition: 'INVALID_STATUS_TRANSITION',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  RateLimited: 'RATE_LIMITED',
  WorkQueueFull: 'WORK_QUEUE_FULL',
  DemoModeDisabled: 'DEMO_MODE_DISABLED',
  SchemaIncompatible: 'SCHEMA_INCOMPATIBLE',
  InternalError: 'INTERNAL_ERROR',
} as const;
export type Code = (typeof Code)[keyof typeof Code];

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: Code,
    readonly detail?: string,
    readonly headers: Record<string, string> = {},
    readonly errors?: Problem['errors'],
  ) {
    super(detail ?? code);
  }
}

export function sendProblem(res: Response, p: HttpProblem, instance?: string): void {
  const body: Problem = {
    type: `https://app.cproj.obed.one/problems/${p.code.toLowerCase().replaceAll('_', '-')}`,
    title: TITLES[p.status] ?? 'Error',
    status: p.status,
    code: p.code,
    ...(p.detail === undefined ? {} : { detail: p.detail }),
    ...(instance === undefined ? {} : { instance }),
    ...(p.errors === undefined ? {} : { errors: p.errors }),
  };
  for (const [k, v] of Object.entries(p.headers)) res.setHeader(k, v);
  res.status(p.status).type('application/problem+json').send(JSON.stringify(body));
}
