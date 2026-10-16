import { describe, expect, it, vi } from 'vitest';

vi.mock('../../providers', () => ({
  providers: {
    email: { name: 'email', vendor: 'smtp', renders: 'ns' },
    sms: { name: 'sms', vendor: 'msg91', renders: 'provider' },
  },
}));

import { channelVendor } from '../vendors';

describe('channelVendor', () => {
  it('returns the deployment vendor and render mode for a channel', () => {
    expect(channelVendor('sms')).toEqual({ vendor: 'msg91', renders: 'provider' });
    expect(channelVendor('email')).toEqual({ vendor: 'smtp', renders: 'ns' });
  });
  it('returns undefined for an unknown channel', () => {
    expect(channelVendor('fax')).toBeUndefined();
  });
});
