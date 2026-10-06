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

  it('prefers variable names carried on the job audit ids', () => {
    const job: Job = {
      job_id: 'j', channel: 'sms', priority: 'realtime', to: '+919999999999',
      template_id: 't', variables: {}, audit: { ...ids, redactValues: true, variableNames: ['message'] },
    };
    expect(toAcceptedRecord(job, 's').payload).toEqual({ to: '+919999999999', variable_names: ['message'] });
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

describe('toAcceptedRecord — payload', () => {
  it('records recipient and variables only; a stray legacy body is not copied into the payload', () => {
    const job = {
      job_id: 'j', channel: 'sms', priority: 'other', to: '+919999999999',
      template_id: 't', variables: { name: 'A' }, body: 'Hi {{name}}', audit: ids,
    } as unknown as Job;
    expect(toAcceptedRecord(job, 's').payload).toEqual({ to: '+919999999999', variables: { name: 'A' } });
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

describe('toAcceptedRecord — content refs', () => {
  const refs = { sms: [{ key: 'tnc.in_force.url', version: 'v3', locale: 'en' }] };
  it('payload includes the content_refs map for redacted and non-redacted jobs', () => {
    const redacted: Job = {
      job_id: 'j', channel: 'sms', priority: 'realtime', to: '+919999999999',
      template_id: 't', variables: {}, audit: { ...ids, redactValues: true, variableNames: ['tnc_url'], contentRefs: refs },
    };
    expect(toAcceptedRecord(redacted, 's').payload).toEqual({ to: '+919999999999', variable_names: ['tnc_url'], content_refs: refs });
    const normal: Job = {
      job_id: 'j', channel: 'sms', priority: 'other', to: '+919999999999',
      template_id: 't', variables: { tnc_url: 'https://example.org/tnc' }, audit: { ...ids, redactValues: false, contentRefs: refs },
    };
    expect(toAcceptedRecord(normal, 's').payload).toMatchObject({ content_refs: refs });
  });

  it('no content_refs key when the job carried none', () => {
    const job: Job = { job_id: 'j', channel: 'sms', priority: 'other', to: '+91', template_id: 't', variables: {}, audit: { ...ids, contentRefs: {} } };
    expect(toAcceptedRecord(job, 's').payload).not.toHaveProperty('content_refs');
  });
});

describe('toAcceptedRecord — event identity', () => {
  it('an event send records its event type and domain, and no event-level template_key', () => {
    const job: Job = {
      job_id: 'j', channel: 'sms', priority: 'other', to: '+919999999999', template_id: 'k_sms',
      variables: {}, audit: { ...ids, eventType: 'apply', domain: 'seeker' },
    };
    expect(toAcceptedRecord(job, 's')).toMatchObject({ eventType: 'apply', domain: 'seeker', templateKey: null, templateId: 'k_sms' });
  });

  it('an event send without a domain records domain null', () => {
    const job: Job = {
      job_id: 'j', channel: 'sms', priority: 'realtime', to: '+91', template_id: 'k',
      variables: {}, audit: { ...ids, eventType: 'apply' },
    };
    expect(toAcceptedRecord(job, 's')).toMatchObject({ eventType: 'apply', domain: null, templateKey: null });
  });

  it('a template_key (or legacy) send records the template and a null event type', () => {
    const job: Job = { job_id: 'j', channel: 'sms', priority: 'other', to: '+91', template_id: 'login_otp', variables: {}, audit: ids };
    expect(toAcceptedRecord(job, 's')).toMatchObject({ eventType: null, domain: null, templateKey: 'login_otp' });
    const withDomain: Job = { ...job, audit: { ...ids, domain: 'seeker' } };
    expect(toAcceptedRecord(withDomain, 's')).toMatchObject({ eventType: null, domain: 'seeker', templateKey: 'login_otp' });
  });
});
