import { describe, expect, it } from 'vitest';
import { isExpired, isRedacted, urgentDefaultDeadlineS, wouldExpire } from '../deadline';

const base = { job_id: 'j', channel: 'sms', priority: 'other' as const, to: 'x', template_id: 't', variables: {} };

describe('deadline', () => {
  it('defaults to 600s and validates', () => {
    expect(urgentDefaultDeadlineS({})).toBe(600);
    expect(urgentDefaultDeadlineS({ URGENT_DEFAULT_DEADLINE_S: '120' })).toBe(120);
    expect(() => urgentDefaultDeadlineS({ URGENT_DEFAULT_DEADLINE_S: '0' })).toThrow('URGENT_DEFAULT_DEADLINE_S');
  });
  it('a job without a deadline never expires', () => {
    expect(isExpired(base, 1e15)).toBe(false);
    expect(wouldExpire(base, 1e12, 0)).toBe(false);
  });
  it('compares against the absolute deadline', () => {
    const j = { ...base, deadline: 1000 };
    expect(isExpired(j, 999)).toBe(false);
    expect(isExpired(j, 1001)).toBe(true);
    expect(wouldExpire(j, 500, 600)).toBe(true);
    expect(wouldExpire(j, 300, 600)).toBe(false);
  });
  it('redaction is sticky over priority', () => {
    expect(isRedacted({ ...base, priority: 'realtime' })).toBe(true);
    expect(isRedacted({ ...base, audit: { eventId: 'e', attemptId: 'a', createdAt: 'c', correlationId: 'c', redactValues: true } })).toBe(true);
    expect(isRedacted({ ...base, priority: 'realtime', audit: { eventId: 'e', attemptId: 'a', createdAt: 'c', correlationId: 'c', redactValues: false } })).toBe(false);
    expect(isRedacted(base)).toBe(false);
  });
});
