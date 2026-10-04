import { describe, expect, it } from 'vitest';
import { parseDeadline, PRIORITY_MAP, V1NotifySchema } from '../request';

const ok = { event_type: 'apply', to: { phone: '+919999999999' }, variables: { name: 'A' } };
const parse = (b: unknown) => V1NotifySchema.safeParse(b);

describe('V1NotifySchema', () => {
  it('accepts a policy-routed send and defaults priority and variables', () => {
    const r = parse({ event_type: 'apply', to: { email: 'a@b.c' } });
    expect(r.success && r.data).toMatchObject({ priority: 'normal', variables: {} });
  });
  it('requires exactly one of event_type / template_key', () => {
    expect(parse({ to: { email: 'a@b.c' } }).success).toBe(false);
    expect(parse({ ...ok, template_key: 'x', channel: 'sms' }).success).toBe(false);
  });
  it('template_key needs channel; event_type forbids it', () => {
    expect(parse({ template_key: 'login_otp', to: { phone: '+919999999999' } }).success).toBe(false);
    expect(parse({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' } }).success).toBe(true);
    expect(parse({ ...ok, channel: 'sms' }).success).toBe(false);
  });
  it('validates recipients and requires at least one', () => {
    expect(parse({ ...ok, to: {} }).success).toBe(false);
    expect(parse({ ...ok, to: { phone: '9999999999' } }).success).toBe(false);
    expect(parse({ ...ok, to: { email: 'not-an-email' } }).success).toBe(false);
  });
  it('rejects network, bodies, sender identity and unknown keys', () => {
    for (const extra of [{ network: 'x' }, { body: 'hi' }, { fromEmail: 'a@b.c' }, { template_id: 'raw' }]) {
      expect(parse({ ...ok, ...extra }).success).toBe(false);
    }
  });
  it('email extras with template_key need channel email', () => {
    expect(parse({ template_key: 'k', channel: 'sms', to: { phone: '+919999999999' }, cc: ['c@d.e'] }).success).toBe(false);
    expect(parse({ template_key: 'k', channel: 'email', to: { email: 'a@b.c' }, cc: ['c@d.e'], reply_to: 'r@b.c' }).success).toBe(true);
  });
  it('maps public priorities', () => {
    expect(PRIORITY_MAP).toEqual({ urgent: 'realtime', normal: 'other', bulk: 'bulk' });
  });
});

describe('parseDeadline', () => {
  const now = Date.parse('2026-10-04T00:00:00Z');
  it('parses a future deadline within 24h', () => {
    expect(parseDeadline('2026-10-04T00:10:00Z', now)).toBe(now + 600_000);
    expect(parseDeadline(undefined, now)).toBeUndefined();
  });
  it('rejects past and too-distant deadlines', () => {
    expect(() => parseDeadline('2026-10-03T23:59:00Z', now)).toThrow('future');
    expect(() => parseDeadline('2026-10-05T00:00:01Z', now)).toThrow('24 hours');
  });
});
