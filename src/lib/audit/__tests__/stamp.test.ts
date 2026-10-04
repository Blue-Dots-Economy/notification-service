import { beforeEach, describe, expect, it, vi } from 'vitest';

const { upsertAttempt, incr } = vi.hoisted(() => ({
  upsertAttempt: vi.fn(async () => {}),
  incr: vi.fn(async () => {}),
}));
vi.mock('../store', () => ({ upsertAttempt }));
vi.mock('../../metrics', () => ({ incr }));

import { stamp } from '../stamp';

const audit = { eventId: 'e', attemptId: 'a', createdAt: '2026-10-04T00:00:00.000Z', correlationId: 'c' };
const job = { job_id: 'j', channel: 'email', priority: 'other' as const, to: 'x', template_id: 't', variables: {}, audit };

describe('stamp', () => {
  beforeEach(() => { upsertAttempt.mockReset().mockResolvedValue(undefined); incr.mockClear(); });

  it('writes the update', async () => {
    await stamp(job, { status: 'sent', attemptNo: 1 });
    expect(upsertAttempt).toHaveBeenCalledWith(expect.objectContaining({ ids: audit }), { status: 'sent', attemptNo: 1 });
  });

  it('swallows a database failure and counts it', async () => {
    upsertAttempt.mockRejectedValueOnce(new Error('db down'));
    await expect(stamp(job, { status: 'sent', attemptNo: 1 })).resolves.toBeUndefined();
    expect(incr).toHaveBeenCalledWith('ns_audit_write_failures_total', { stage: 'sent' });
  });

  it('skips jobs queued before audit ids existed', async () => {
    await stamp({ ...job, audit: undefined }, { status: 'sent', attemptNo: 1 });
    expect(upsertAttempt).not.toHaveBeenCalled();
  });

  it('never throws even when building the record throws', async () => {
    const bad = { ...job, get priority(): never { throw new Error('boom'); } };
    await expect(stamp(bad as never, { status: 'sent', attemptNo: 1 })).resolves.toBeUndefined();
    expect(incr).toHaveBeenCalledWith('ns_audit_write_failures_total', { stage: 'sent' });
  });
});
