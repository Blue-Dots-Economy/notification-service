import { getPool } from '../db/client';
import { providers } from '../providers';
import { currentNetwork, NetworkNotConfigured } from '../network';
import { TemplateError } from './errors';
import { createTemplateDraft, listTemplates, publishTemplate } from './repo';

type SeedOutcome = 'seeded_active' | 'seeded_draft' | 'exists' | 'skipped_no_network' | 'skipped_no_id';

/**
 * Bring the one template NS already names — `login_otp` on SMS — into the
 * registry, so login OTP resolves through it from the first deploy. Runs every
 * boot and does nothing once any login_otp row exists: an admin's edits always
 * win over environment defaults.
 *
 * Replicas booting together serialise on a session advisory lock held on a
 * dedicated connection, so the existence check and the create+publish cannot
 * interleave across replicas.
 */
export async function seedBuiltinTemplates(): Promise<SeedOutcome> {
  try {
    currentNetwork();
  } catch (e) {
    if (e instanceof NetworkNotConfigured) return 'skipped_no_network';
    throw e;
  }
  const client = await getPool().connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('notification-service:seed'))`);
    try {
      return await seedLocked();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('notification-service:seed'))`);
    }
  } finally {
    client.release();
  }
}

async function seedLocked(): Promise<SeedOutcome> {
  const existing = await listTemplates({ channel: 'sms', templateKey: 'login_otp' });
  if (existing.length > 0) return 'exists';

  const sms = providers.sms;
  const id = sms?.templates.login_otp;
  if (!sms || !id) {
    console.log('login_otp is not configured for the SMS provider; template not seeded');
    return 'skipped_no_id';
  }

  const draft = await createTemplateDraft(
    {
      channel: 'sms',
      templateKey: 'login_otp',
      providerTemplateId: id,
      bodyText: sms.bodies?.login_otp || process.env.SMS_LOGIN_OTP_BODY || null,
      variables: [{ name: 'message', required: true, type: 'string', sensitive: true, raw: false }],
    },
    'system:seed',
  );
  try {
    await publishTemplate(draft.id, 'system:seed');
    return 'seeded_active';
  } catch (e) {
    if (e instanceof TemplateError) {
      console.log(`login_otp seeded as a draft: ${e.code}`);
      return 'seeded_draft';
    }
    throw e;
  }
}
