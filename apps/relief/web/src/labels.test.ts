import { describe, expect, it } from 'vitest';
import { isAllowedStatusTransition, RequestStatus } from '@drproj/contracts';
import { ACTIONS, describeInstance } from './labels';

describe('status buttons', () => {
  it('offer exactly the transitions the API allows', () => {
    for (const from of RequestStatus.options) {
      const allowed = RequestStatus.options.filter((to) => isAllowedStatusTransition(from, to)).sort();
      expect(ACTIONS[from].map((a) => a.to).sort()).toEqual(allowed);
    }
  });
});

describe('describeInstance', () => {
  const main = { id: 'primary-1', label: 'Main server', provider: 'self_hosted' };
  it('adds the looked-up city to a self-hosted server', () => {
    expect(describeInstance({ ...main, region: 'Pune, IN' })).toBe('Main server · self-hosted · Pune, IN');
  });
  it('shows plain "self-hosted" when no location is known', () => {
    expect(describeInstance({ ...main, region: null })).toBe('Main server · self-hosted');
  });
  it('keeps provider region and city for cloud servers', () => {
    const warm = { id: 'w', label: 'Backup server', provider: 'digitalocean', region: 'fra1 (Frankfurt)' };
    expect(describeInstance(warm)).toBe('Backup server · DigitalOcean fra1 (Frankfurt)');
  });
  it('falls back to the raw id without a label', () => {
    expect(describeInstance({ id: 'x', label: null, provider: null, region: null })).toBe('x');
  });
});
