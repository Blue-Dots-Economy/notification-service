import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '../client';
import { runMigrations } from '../migrate';

beforeAll(async () => { await runMigrations(); });
afterAll(async () => { await closeDb(); });
beforeEach(async () => {
  await getPool().query(`DELETE FROM template; DELETE FROM notification_policy;`);
});

const insertTemplate = (version: number, status: string) =>
  getPool().query(
    `INSERT INTO template (network, channel, template_key, locale, version, status, provider, created_by)
     VALUES ('n', 'sms', 'login_otp', 'en', $1, $2, 'msg91', 't')`,
    [version, status],
  );

const insertPolicy = (version: number, status: string, domain: string | null, eventType: string | null) =>
  getPool().query(
    `INSERT INTO notification_policy (network, domain, event_type, version, status, mode, channels, created_by)
     VALUES ('n', $3, $4, $1, $2, 'first_available', '[]'::jsonb, 't')`,
    [version, status, domain, eventType],
  );

describe('catalogue schema', () => {
  it('allows one active template per key and any number of retired', async () => {
    await insertTemplate(1, 'retired');
    await insertTemplate(2, 'active');
    await expect(insertTemplate(3, 'active')).rejects.toThrow(/template_active_uq/);
    await expect(insertTemplate(3, 'retired')).resolves.toBeDefined();
  });

  it('rejects a duplicate version and an unknown status', async () => {
    await insertTemplate(1, 'draft');
    await expect(insertTemplate(1, 'draft')).rejects.toThrow(/template_version_uq/);
    await expect(insertTemplate(9, 'live')).rejects.toThrow(/template_status_ck/);
  });

  it('treats NULL domain/event_type as one scope for the active policy', async () => {
    await insertPolicy(1, 'active', null, null);
    await expect(insertPolicy(2, 'active', null, null)).rejects.toThrow(/policy_active_uq/);
    await expect(insertPolicy(2, 'active', 'seeker', null)).resolves.toBeDefined();
  });

  it('rejects an unknown policy mode', async () => {
    await expect(
      getPool().query(
        `INSERT INTO notification_policy (network, version, status, mode, channels, created_by)
         VALUES ('n', 1, 'draft', 'broadcast', '[]'::jsonb, 't')`,
      ),
    ).rejects.toThrow(/policy_mode_ck/);
  });
});
