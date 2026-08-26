import { describe, expect, it } from 'vitest';

// Pure key derivation, so no Redis double is needed here — that is the point of
// keeping it out of dedupe.ts.
import { buildDedupeKey } from '../dedupe_key';

describe('buildDedupeKey', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    channel: 'email',
    to: 'asha@example.com',
    template_id: 'basic_email',
    variables: { subject: 'Activate your account', html: '<p>click</p>' },
    ...over,
  });

  it('uses an explicit dedupe_id verbatim, with the long window', () => {
    const built = buildDedupeKey(payload({ dedupe_id: 'item_lifecycle:profile.create:u1:item-9' }));

    expect(built).toEqual({
      key: 'item_lifecycle:profile.create:u1:item-9',
      ttlSeconds: 3600,
      explicit: true,
    });
  });

  it('falls back to a content-addressed key with the short window', () => {
    const built = buildDedupeKey(payload());

    expect(built.explicit).toBe(false);
    expect(built.ttlSeconds).toBe(5);
    // Recipient scoping is retained so the key stays greppable in Redis; the
    // hash is what makes it message-identifying.
    expect(built.key).toMatch(/^email:asha@example\.com:basic_email:[0-9a-f]{32}$/);
  });

  // The bug this whole change exists for: Signals sends every email as
  // template_id 'basic_email', so a template-only key collapses two unrelated
  // messages to one recipient into a single send (#88).
  it('distinguishes two different messages to the same recipient', () => {
    const welcome = buildDedupeKey(payload({ variables: { subject: 'Welcome!', html: '<p>hi</p>' } }));
    const activate = buildDedupeKey(payload({ variables: { subject: 'Activate', html: '<p>go</p>' } }));

    expect(welcome.key).not.toBe(activate.key);
  });

  it('is stable across variable key order, including nested objects', () => {
    const a = buildDedupeKey(payload({
      variables: { subject: 's', html: 'h', meta: { b: 2, a: 1 } },
    }));
    const b = buildDedupeKey(payload({
      variables: { meta: { a: 1, b: 2 }, html: 'h', subject: 's' },
    }));

    expect(a.key).toBe(b.key);
  });

  it('distinguishes recipients and channels carrying an identical message', () => {
    const keys = new Set([
      buildDedupeKey(payload()).key,
      buildDedupeKey(payload({ to: 'bhanu@example.com' })).key,
      buildDedupeKey(payload({ channel: 'sms' })).key,
    ]);

    expect(keys.size).toBe(3);
  });

  it('distinguishes two OTPs to the same recipient, so neither is swallowed', () => {
    const first = buildDedupeKey(payload({ variables: { subject: 'OTP', html: '<b>123456</b>' } }));
    const second = buildDedupeKey(payload({ variables: { subject: 'OTP', html: '<b>654321</b>' } }));

    expect(first.key).not.toBe(second.key);
  });
});
