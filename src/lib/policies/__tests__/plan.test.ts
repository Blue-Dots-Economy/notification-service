import { describe, expect, it } from 'vitest';
import { planDelivery } from '../plan';

const policy = (mode: 'first_available' | 'all') => ({
  mode,
  channels: [
    { channel: 'sms', template_key: 'otp_sms' },
    { channel: 'email', template_key: 'otp_email' },
    { channel: 'whatsapp', template_key: 'otp_wa' },
  ],
});

describe('planDelivery', () => {
  it('keeps policy order and drops channels the caller has no contact point for', () => {
    expect(planDelivery(policy('first_available'), { email: 'a@b.c' })).toEqual({
      mode: 'first_available', candidates: [{ channel: 'email', template_key: 'otp_email' }],
    });
  });
  it('phone-only recipients get the phone channels in order', () => {
    expect(planDelivery(policy('all'), { phone: '+919999999999' }).candidates.map((c) => c.channel)).toEqual(['sms', 'whatsapp']);
  });
  it('no reachable channel → no candidates', () => {
    expect(planDelivery(policy('all'), {}).candidates).toEqual([]);
  });
  it('treats blank contact points as absent and unknown channels as unreachable', () => {
    expect(planDelivery({ mode: 'all', channels: [{ channel: 'fax', template_key: 'x' }, { channel: 'email', template_key: 'e' }] }, { email: ' ' }).candidates).toEqual([]);
  });
});
