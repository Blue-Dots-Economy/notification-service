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

describe('toAcceptedRecord — sticky redaction', () => {
  it('keeps a realtime-origin job redacted after a DLQ replay moves it to other', () => {
    const job: Job = {
      job_id: 'j', channel: 'sms', priority: 'other', to: '+919999999999',
      template_id: 'login_otp', variables: { message: '482913' },
      audit: { ...ids, redactValues: true },
    };
    const rec = toAcceptedRecord(job, 'worker');
    expect(JSON.stringify(rec)).not.toContain('482913');
    expect(rec.payload).toEqual({ to: '+919999999999', variable_names: ['message'] });
    expect(rec.job).toBeUndefined();
    expect(rec.recoverable).toBe(false);
  });

  it('keeps values for a normal-origin job even when replayed as realtime', () => {
    const job: Job = {
      job_id: 'j', channel: 'email', priority: 'realtime', to: 'a@b.c',
      template_id: 'basic_email', variables: { subject: 's' },
      audit: { ...ids, redactValues: false },
    };
    const rec = toAcceptedRecord(job, 'worker');
    expect(rec.recoverable).toBe(true);
    expect(rec.job).toMatchObject({ variables: { subject: 's' } });
  });
});

describe('toAcceptedRecord — email attachments', () => {
  const data = Buffer.from('%PDF-1.7 secret contract body').toString('base64');
  const job: Job = {
    job_id: 'j', channel: 'email', priority: 'other', to: 'a@b.c', template_id: 'basic_email',
    variables: { subject: 's', attachments: [{ filename: 'c.pdf', contentType: 'application/pdf', data }] },
    audit: ids,
  };

  it('drops attachment bodies from the payload, keeping filename, contentType and size', () => {
    const rec = toAcceptedRecord(job, 'x');
    expect(JSON.stringify(rec.payload)).not.toContain(data);
    expect((rec.payload.variables as { attachments: unknown[] }).attachments).toEqual([
      { filename: 'c.pdf', contentType: 'application/pdf', size: Buffer.from(data, 'base64').length },
    ]);
    expect((rec.payload.variables as { subject: string }).subject).toBe('s');
  });

  it('keeps the attachments intact in the job copy, which recovery re-sends', () => {
    const rec = toAcceptedRecord(job, 'x');
    expect((rec.job as { variables: { attachments: Array<{ data: string }> } }).variables.attachments[0]!.data).toBe(data);
    // The original job is not mutated.
    expect((job.variables.attachments[0] as { data: string }).data).toBe(data);
  });
});
