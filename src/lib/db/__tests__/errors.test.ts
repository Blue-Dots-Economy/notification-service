import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describeDbError } from '../errors';

describe('describeDbError', () => {
  it('never includes the parameters a DrizzleQueryError embeds in its message', () => {
    const cause = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const err = new DrizzleQueryError(
      'INSERT INTO notification_event (payload) VALUES ($1)',
      ['{"to":"asha@example.com","variables":{"otp":"123456"}}'],
      cause,
    );
    expect(err.message).toContain('asha@example.com');
    const out = describeDbError(err);
    expect(out).toBe('[23505] duplicate key value violates unique constraint');
    expect(out).not.toContain('asha@example.com');
    expect(out).not.toContain('123456');
  });

  it('handles a DrizzleQueryError-shaped object without cause', () => {
    const err = { name: 'DrizzleQueryError', message: 'Failed query: x\nparams: +919999999999', query: 'x', params: [] };
    expect(describeDbError(err)).toBe('database query failed');
  });

  it('summarises a plain driver error with its code', () => {
    const err = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    expect(describeDbError(err)).toBe('[57014] canceling statement due to statement timeout');
  });

  it('bounds the length', () => {
    expect(describeDbError(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(201);
  });

  it('copes with non-errors', () => {
    expect(describeDbError('boom')).toBe('boom');
    expect(describeDbError(undefined)).toBe('undefined');
  });
});
