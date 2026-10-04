import { describe, expect, it } from 'vitest';
import { ATTEMPT_RANK, eventStatusFor } from '../status';

describe('status ranks', () => {
  it('orders queued < dispatching < sent < terminal', () => {
    expect(ATTEMPT_RANK.queued).toBeLessThan(ATTEMPT_RANK.dispatching);
    expect(ATTEMPT_RANK.dispatching).toBeLessThan(ATTEMPT_RANK.sent);
    expect(ATTEMPT_RANK.sent).toBeLessThan(ATTEMPT_RANK.failed);
    expect(ATTEMPT_RANK.failed).toBe(ATTEMPT_RANK.expired);
  });

  it('maps attempt status to event status', () => {
    expect(eventStatusFor('queued')).toBe('accepted');
    expect(eventStatusFor('dispatching')).toBe('dispatching');
    expect(eventStatusFor('sent')).toBe('sent');
    expect(eventStatusFor('failed')).toBe('failed');
    expect(eventStatusFor('expired')).toBe('expired');
  });
});
