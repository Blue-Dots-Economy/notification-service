import { loadCatalogueFile, seedCatalogue } from '../catalogue/seed';
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client';
import { providers } from '../providers';
import { currentNetwork, NetworkNotConfigured } from '../network';
import { TemplateError } from './errors';
import { createTemplateDraft, listTemplates, publishTemplate } from './repo';

const SEED_LOCK = 'notification-service:seed';
/** Server-side bound on the seed-lock wait; the client bound sits just above it. */
const LOCK_WAIT_STATEMENT_TIMEOUT = '120s';
const LOCK_WAIT_QUERY_TIMEOUT_MS = 125_000;

type SeedOutcome = 'seeded_active' | 'seeded_draft' | 'exists' | 'skipped_no_network' | 'skipped_no_id';

/**
 * The login_otp template this deployment explicitly configured for its SMS
 * vendor, or undefined (seed outcome `skipped_no_id`):
 * - msg91: `SMS_LOGIN_OTP_TEMPLATE_ID`. Only the env value counts, never a
 *   built-in fallback flow id, which the seed would publish and never revisit.
 * - pinnacle: `PINNACLE_LOGIN_OTP_TEMPLATE_ID`.
 * A blank id is unset. The body is `SMS_LOGIN_OTP_BODY` as written (byte-exact,
 * since the DLT operator matches on it), or null when unset or empty; pinnacle
 * without a body seeds a draft, because publish requires a body when NS renders.
 */
export function configuredLoginOtp(
  vendor: string,
  env: NodeJS.ProcessEnv = process.env,
): { id: string; body: string | null } | undefined {
  const raw =
    vendor === 'msg91' ? env.SMS_LOGIN_OTP_TEMPLATE_ID : vendor === 'pinnacle' ? env.PINNACLE_LOGIN_OTP_TEMPLATE_ID : undefined;
  const id = raw?.trim();
  if (!id) return undefined;
  return { id, body: env.SMS_LOGIN_OTP_BODY || null };
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
  const destroyOn = (e: unknown): never => {
    // The session may hold the lock or a raised timeout: hand the error to
    // release so the pool destroys this connection instead of reusing it.
    releaseErr = e instanceof Error ? e : new Error(String(e));
    throw e;
  };
  try {
    // Only the lock wait is raised: a replica booting beside one that is still
    // seeding a large catalogue waits for it instead of skipping its own seed.
    // The seeding itself runs on other pool connections at the normal bounds.
    try {
      await client.query(`SET statement_timeout = '${LOCK_WAIT_STATEMENT_TIMEOUT}'`);
      await client.query({
        text: 'SELECT pg_advisory_lock(hashtext($1))',
        values: [SEED_LOCK],
        query_timeout: LOCK_WAIT_QUERY_TIMEOUT_MS,
      } as QueryConfig);
      await client.query('RESET statement_timeout');
    } catch (e) {
      // A client-side timeout leaves the lock request running on the server,
      // so this connection may still acquire the lock: never reuse it.
      destroyOn(e);
    }
    try {
      return await seedLocked();
    } finally {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext('${SEED_LOCK}'))`);
      } catch (e) {
        destroyOn(e);
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
  if (sms && existing.some((t) => t.provider === sms.vendor)) return 'exists';

  const configured = sms ? configuredLoginOtp(sms.vendor) : undefined;
  if (!sms || !configured) {
    console.log('login_otp is not configured for the SMS provider; template not seeded');
    return 'skipped_no_id';
  }

  const draft = await createTemplateDraft(
    {
      channel: 'sms',
      templateKey: 'login_otp',
      providerTemplateId: configured.id,
      bodyText: configured.body,
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
