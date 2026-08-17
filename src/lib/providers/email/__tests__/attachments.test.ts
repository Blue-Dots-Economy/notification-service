import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTACHMENT_MAX_FILES,
  DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES,
  attachmentMaxFiles,
  attachmentMaxTotalBytes,
  decodedBase64Length,
  notifyBodyLimitBytes,
  totalAttachmentBytes,
} from '../attachments';

const ENV_KEYS = [
  'NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES',
  'NOTIFY_ATTACHMENT_MAX_FILES',
  'NOTIFY_BODY_LIMIT_BYTES',
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('decodedBase64Length', () => {
  it('matches the real decoded length for every padding case', () => {
    for (const raw of ['a', 'ab', 'abc', 'abcd', 'hello world', '']) {
      const encoded = Buffer.from(raw).toString('base64');
      expect(decodedBase64Length(encoded)).toBe(raw.length);
    }
  });

  it('ignores line breaks in wrapped base64', () => {
    const raw = 'x'.repeat(200);
    const wrapped = Buffer.from(raw).toString('base64').replace(/(.{20})/g, '$1\n');
    expect(decodedBase64Length(wrapped)).toBe(raw.length);
  });

  it('sums across attachments and treats an absent list as zero', () => {
    const oneKb = Buffer.alloc(1024).toString('base64');
    expect(totalAttachmentBytes([{ data: oneKb }, { data: oneKb }])).toBe(2048);
    expect(totalAttachmentBytes(undefined)).toBe(0);
  });
});

describe('limits', () => {
  it('defaults to 5MB across at most 3 files', () => {
    expect(attachmentMaxTotalBytes()).toBe(DEFAULT_ATTACHMENT_MAX_TOTAL_BYTES);
    expect(attachmentMaxTotalBytes()).toBe(5 * 1024 * 1024);
    expect(attachmentMaxFiles()).toBe(DEFAULT_ATTACHMENT_MAX_FILES);
  });

  it('honours env overrides', () => {
    process.env.NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES = '1048576';
    process.env.NOTIFY_ATTACHMENT_MAX_FILES = '1';
    expect(attachmentMaxTotalBytes()).toBe(1048576);
    expect(attachmentMaxFiles()).toBe(1);
  });

  it('falls back to the default when an override is not a positive integer', () => {
    for (const bad of ['0', '-5', 'abc', '1.5']) {
      process.env.NOTIFY_ATTACHMENT_MAX_FILES = bad;
      expect(attachmentMaxFiles()).toBe(DEFAULT_ATTACHMENT_MAX_FILES);
    }
  });
});

describe('notifyBodyLimitBytes', () => {
  it('exceeds the base64-inflated attachment budget', () => {
    const cap = attachmentMaxTotalBytes();
    expect(notifyBodyLimitBytes()).toBeGreaterThan(Math.ceil((cap * 4) / 3));
  });

  it('tracks the attachment cap, so raising the cap cannot cause a 413', () => {
    const atDefault = notifyBodyLimitBytes();
    process.env.NOTIFY_ATTACHMENT_MAX_TOTAL_BYTES = String(20 * 1024 * 1024);
    const raised = notifyBodyLimitBytes();
    expect(raised).toBeGreaterThan(atDefault);
    expect(raised).toBeGreaterThan(Math.ceil((20 * 1024 * 1024 * 4) / 3));
  });

  it('is overridden outright by NOTIFY_BODY_LIMIT_BYTES', () => {
    process.env.NOTIFY_BODY_LIMIT_BYTES = '999';
    expect(notifyBodyLimitBytes()).toBe(999);
  });
});
