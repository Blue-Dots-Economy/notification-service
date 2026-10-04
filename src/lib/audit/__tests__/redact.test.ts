import { describe, expect, it } from 'vitest';
import type { Job } from 'src/types';
import { toAcceptedRecord } from '../redact';

const ids = { eventId: 'e', attemptId: 'a', createdAt: '2026-10-04T00:00:00.000Z', correlationId: 'c' };

describe('toAcceptedRecord', () => {
  it('keeps no variable values or body for a realtime job, and marks it unrecoverable', () => {
    const job: Job = {
      job_id: 'j', channel: 'sms', priority: 'realtime', to: '+919999999999',
      template_id: 'login_otp', variables: { message: '123456' }, audit: ids,
    };
    const rec = toAcceptedRecord(job, 'keycloak');
    expect(JSON.stringify(rec)).not.toContain('123456');
    expect(rec.payload).toEqual({ to: '+919999999999', variable_names: ['message'] });
    expect(rec.job).toBeUndefined();
    expect(rec.recoverable).toBe(false);
  });

  it('keeps the full job for a normal job so it can be recovered', () => {
    const job: Job = {
      job_id: 'j', channel: 'email', priority: 'other', to: 'a@b.c',
      template_id: 'basic_email', variables: { subject: 's' }, audit: ids,
    };
    const rec = toAcceptedRecord(job, 'dpg-api-client');
    expect(rec.recoverable).toBe(true);
    expect(rec.job).toMatchObject({ job_id: 'j', variables: { subject: 's' } });
    expect(rec.source).toBe('dpg-api-client');
  });
});
