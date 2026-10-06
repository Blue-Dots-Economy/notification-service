import { loadCatalogueFile, seedCatalogue } from '../catalogue/seed';
import { getPool } from '../db/client';
import { providers } from '../providers';
import { currentNetwork, NetworkNotConfigured } from '../network';
import { TemplateError } from './errors';
import { createTemplateDraft, isUntouchedSeedDraft, listTemplates, publishTemplate, reapplySeedDraft } from './repo';

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
 * Then, when `NS_SEED_FILE` names a catalogue, every catalogue template and
 * policy that has no row yet is created and published (existing rows always
 * win); the login_otp outcome is still what this returns.
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
  const outcome = await seedLoginOtp();
  const file = process.env.NS_SEED_FILE?.trim();
  if (file) {
    const catalogue = await loadCatalogueFile(file);
    if (catalogue) {
      const report = await seedCatalogue(catalogue);
      // Counts only: the report never carries template bodies or variable values.
      console.log(`catalogue ${catalogue.version} seeded: ${JSON.stringify(report)}`);
    }
  }
  return outcome;
}

async function seedLoginOtp(): Promise<SeedOutcome> {
  const sms = providers.sms;
  const existing = await listTemplates({ channel: 'sms', templateKey: 'login_otp' });
  const own = sms ? existing.filter((t) => t.provider === sms.vendor) : [];
  // Only the seed's own untouched drafts are retried (e.g. the id was set
  // before the body); anything an admin made, edited or published wins.
  if (own.length > 0 && !own.every(isUntouchedSeedDraft)) return 'exists';

  const id = sms ? configuredLoginOtpId(sms) : undefined;
  if (!sms || !id) {
    console.log('login_otp is not configured for the SMS provider; template not seeded');
    return 'skipped_no_id';
  }

  const values = {
    providerTemplateId: id,
    bodyText: sms.bodies?.login_otp || process.env.SMS_LOGIN_OTP_BODY || null,
    variables: [{ name: 'message', required: true, type: 'string' as const, sensitive: true, raw: false }],
  };
  let draftId: string;
  if (own.length > 0) {
    const latest = own.reduce((a, b) => (b.version > a.version ? b : a));
    try {
      draftId = (await reapplySeedDraft(latest.id, values)).id;
    } catch (e) {
      // An admin edited it since the listing: theirs wins.
      if (e instanceof TemplateError && e.code === 'invalid_state') return 'exists';
      throw e;
    }
  } else {
    draftId = (await createTemplateDraft({ channel: 'sms', templateKey: 'login_otp', ...values }, 'system:seed')).id;
  }
  try {
    await publishTemplate(draftId, 'system:seed');
    return 'seeded_active';
  } catch (e) {
    if (e instanceof TemplateError) {
      console.warn(`login_otp seeded as a draft (retried next boot): ${e.code}`);
      return 'seeded_draft';
    }
    throw e;
  }
}
