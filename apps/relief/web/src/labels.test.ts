import { describe, expect, it } from 'vitest';
import { isAllowedStatusTransition, RequestStatus } from '@drproj/contracts';
import { ACTIONS } from './labels';

describe('status buttons', () => {
  it('offer exactly the transitions the API allows', () => {
    for (const from of RequestStatus.options) {
      const allowed = RequestStatus.options.filter((to) => isAllowedStatusTransition(from, to)).sort();
      expect(ACTIONS[from].map((a) => a.to).sort()).toEqual(allowed);
    }
  });
});
