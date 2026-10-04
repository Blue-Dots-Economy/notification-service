import { getPool } from '../db/client';
import { providers } from '../providers';
import { currentNetwork, NetworkNotConfigured } from '../network';
import { TemplateError } from './errors';
import { createTemplateDraft, listTemplates, publishTemplate } from './repo';

type SeedOutcome = 'seeded_active' | 'seeded_draft' | 'exists' | 'skipped_no_network' | 'skipped_no_id';

/**
 * The login_otp id this deployment explicitly configured for its SMS vendor, or
 * undefined. Read from the environment directly rather than the provider map:
 * msg91's map falls back to a hardcoded legacy flow id, which must never be
 * published into the registry (the seed would never revisit it).
 */
function configuredLoginOtpId(sms: { vendor: string; templates: Record<string, string> }): string | undefined {
  const id = sms.vendor === 'msg91' ? process.env.SMS_LOGIN_OTP_TEMPLATE_ID : sms.templates.login_otp;
  return id?.trim() || undefined;
}

/**
 * Bring the one template NS already names — `login_otp` on SMS — into the
 * registry, so login OTP resolves through it from the first deploy. Runs every
 * boot and does nothing once a login_otp row exists for the deployment's
 * current SMS vendor: an admin's edits always win over environment defaults.
 * If rows exist only for another vendor (the deployment switched vendor), the
 * current vendor's configured template is seeded and published, which retires
 * the old vendor's active row — its ids mean nothing to the new vendor.
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
  let releaseErr: Error | undefined;
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('notification-service:seed'))`);
    try {
      return await seedLocked();
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('notification-service:seed'))`);
      } catch (e) {
        // The session may still hold the lock: hand the error to release so
        // the pool destroys this connection instead of reusing it.
        releaseErr = e instanceof Error ? e : new Error(String(e));
        throw e;
      }
    }
  } finally {
    client.release(releaseErr);
  }
}

async function seedLocked(): Promise<SeedOutcome> {
  const sms = providers.sms;
  const existing = await listTemplates({ channel: 'sms', templateKey: 'login_otp' });
  if (sms && existing.some((t) => t.provider === sms.vendor)) return 'exists';

  const id = sms ? configuredLoginOtpId(sms) : undefined;
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
