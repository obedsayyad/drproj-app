import { describe, expect, it } from 'vitest';
import { isAllowedStatusTransition, ReliefRequestInput, ReliefStatusPatch, type RequestStatus } from './relief.js';

const valid = { resource_type: 'water', quantity: 5, location: 'Shelter 4', urgency: 'high' };

describe('ReliefRequestInput', () => {
  it('accepts a valid request', () => {
    expect(ReliefRequestInput.safeParse(valid).success).toBe(true);
  });

  it.each([
    [0, false],
    [1, true],
    [10000, true],
    [10001, false],
    [1.5, false],
    ['5', false],
    [-3, false],
  ])('quantity %j -> %s', (quantity, ok) => {
    expect(ReliefRequestInput.safeParse({ ...valid, quantity }).success).toBe(ok);
  });

  it('bounds location length to 1..500', () => {
    expect(ReliefRequestInput.safeParse({ ...valid, location: '' }).success).toBe(false);
    expect(ReliefRequestInput.safeParse({ ...valid, location: 'x'.repeat(500) }).success).toBe(true);
    expect(ReliefRequestInput.safeParse({ ...valid, location: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects unknown properties and unknown enum values', () => {
    expect(ReliefRequestInput.safeParse({ ...valid, status: 'resolved' }).success).toBe(false);
    expect(ReliefRequestInput.safeParse({ ...valid, urgency: 'asap' }).success).toBe(false);
  });
});

describe('ReliefStatusPatch', () => {
  it('requires expected_version >= 1', () => {
    expect(ReliefStatusPatch.safeParse({ status: 'resolved', expected_version: 0 }).success).toBe(false);
    expect(ReliefStatusPatch.safeParse({ status: 'resolved' }).success).toBe(false);
    expect(ReliefStatusPatch.safeParse({ status: 'resolved', expected_version: 1 }).success).toBe(true);
  });
});

describe('isAllowedStatusTransition', () => {
  const all: RequestStatus[] = ['pending', 'in_progress', 'resolved'];
  const allowed = new Set(['pending>in_progress', 'in_progress>resolved', 'in_progress>pending', 'resolved>in_progress']);
  for (const from of all)
    for (const to of all)
      it(`${from} -> ${to}`, () => {
        expect(isAllowedStatusTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
      });
});
