import { and, eq, isNull, max, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client';
import { notificationPolicy, type LifecycleStatus, type PolicyChannel, type PolicyMode, type PolicyRow } from '../db/schema';
import { currentNetwork } from '../network';
import { TemplateError } from '../templates/errors';
import { hasActiveTemplate } from '../templates/repo';
import { channelVendor } from '../templates/vendors';

export interface PolicyDraftInput {
  domain?: string | null;
  eventType?: string | null;
  mode: PolicyMode;
  channels: PolicyChannel[];
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

const scopeEq = (col: typeof notificationPolicy.domain | typeof notificationPolicy.eventType, v: string | null | undefined): SQL =>
  v == null ? isNull(col) : eq(col, v);

async function lockScope(tx: Tx, network: string, domain: string | null, eventType: string | null) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`policy:${network}:${domain ?? ''}:${eventType ?? ''}`}))`);
}

async function loadForUpdate(tx: Tx, id: string): Promise<PolicyRow> {
  const rows = await tx
    .select()
    .from(notificationPolicy)
    .where(and(eq(notificationPolicy.id, id), eq(notificationPolicy.network, currentNetwork())))
    .for('update');
  if (!rows[0]) throw new TemplateError('not_found', 'policy not found');
  return rows[0];
}

export async function createPolicyDraft(input: PolicyDraftInput, actor: string): Promise<PolicyRow> {
  const network = currentNetwork();
  const domain = input.domain ?? null;
  const eventType = input.eventType ?? null;
  return getDb().transaction(async (tx) => {
    await lockScope(tx, network, domain, eventType);
    const [{ v }] = await tx
      .select({ v: max(notificationPolicy.version) })
      .from(notificationPolicy)
      .where(and(eq(notificationPolicy.network, network), scopeEq(notificationPolicy.domain, domain), scopeEq(notificationPolicy.eventType, eventType)));
    const [row] = await tx
      .insert(notificationPolicy)
      .values({ network, domain, eventType, mode: input.mode, channels: input.channels, version: (v ?? 0) + 1, status: 'draft', createdBy: actor })
      .returning();
    return row!;
  });
}

export async function updatePolicyDraft(id: string, patch: { mode?: PolicyMode; channels?: PolicyChannel[] }): Promise<PolicyRow> {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, id);
    if (current.status !== 'draft') throw new TemplateError('invalid_state', `only drafts can be edited; this one is ${current.status}`);
    const [row] = await tx.update(notificationPolicy).set({
        ...(patch.mode !== undefined && { mode: patch.mode }),
        ...(patch.channels !== undefined && { channels: patch.channels }),
        updatedAt: new Date(),
      }).where(eq(notificationPolicy.id, id)).returning();
    return row!;
  });
}

async function validatePolicy(p: PolicyRow): Promise<void> {
  if (p.channels.length === 0) throw new TemplateError('incomplete_template', 'a policy needs at least one channel');
  const seen = new Set<string>();
  for (const c of p.channels) {
    if (seen.has(c.channel)) throw new TemplateError('invalid_contract', `channel ${c.channel} listed twice`);
    seen.add(c.channel);
    if (!channelVendor(c.channel)) throw new TemplateError('unknown_channel', `no provider for channel ${c.channel}`);
    if (!(await hasActiveTemplate(c.channel, c.template_key))) {
      throw new TemplateError('incomplete_template', `no active ${c.channel} template ${c.template_key}`, {
        channel: c.channel, template_key: c.template_key,
      });
    }
  }
}

export async function publishPolicy(id: string, actor: string): Promise<PolicyRow> {
  return getDb().transaction(async (tx) => {
    const peek = await loadForUpdate(tx, id);
    await lockScope(tx, peek.network, peek.domain, peek.eventType);
    const current = await loadForUpdate(tx, id);
    if (current.status !== 'draft') throw new TemplateError('invalid_state', `only drafts can be published; this one is ${current.status}`);
    await validatePolicy(current);
    const now = new Date();
    await tx
      .update(notificationPolicy)
      .set({ status: 'retired', retiredAt: now, updatedAt: now })
      .where(and(
        eq(notificationPolicy.network, current.network),
        scopeEq(notificationPolicy.domain, current.domain),
        scopeEq(notificationPolicy.eventType, current.eventType),
        eq(notificationPolicy.status, 'active'),
      ));
    const [row] = await tx
      .update(notificationPolicy)
      .set({ status: 'active', publishedAt: now, publishedBy: actor, updatedAt: now })
      .where(eq(notificationPolicy.id, id))
      .returning();
    return row!;
  });
}

export async function retirePolicy(id: string): Promise<PolicyRow> {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, id);
    if (current.status === 'retired') throw new TemplateError('invalid_state', 'already retired');
    const now = new Date();
    const [row] = await tx.update(notificationPolicy).set({ status: 'retired', retiredAt: now, updatedAt: now }).where(eq(notificationPolicy.id, id)).returning();
    return row!;
  });
}

export async function getPolicy(id: string): Promise<PolicyRow> {
  const rows = await getDb().select().from(notificationPolicy).where(and(eq(notificationPolicy.id, id), eq(notificationPolicy.network, currentNetwork())));
  if (!rows[0]) throw new TemplateError('not_found', 'policy not found');
  return rows[0];
}

export async function listPolicies(filter: { domain?: string; eventType?: string; status?: LifecycleStatus }): Promise<PolicyRow[]> {
  const conds = [eq(notificationPolicy.network, currentNetwork())];
  if (filter.domain) conds.push(eq(notificationPolicy.domain, filter.domain));
  if (filter.eventType) conds.push(eq(notificationPolicy.eventType, filter.eventType));
  if (filter.status) conds.push(eq(notificationPolicy.status, filter.status));
  return getDb().select().from(notificationPolicy).where(and(...conds)).orderBy(notificationPolicy.eventType, notificationPolicy.domain, notificationPolicy.version);
}

/** Specificity rank of an active policy for (domain, eventType); lower wins. */
function rank(p: PolicyRow): number {
  if (p.domain !== null && p.eventType !== null) return 0;
  if (p.domain === null && p.eventType !== null) return 1;
  if (p.domain !== null && p.eventType === null) return 2;
  return 3;
}

/**
 * The active policy for a send. Most specific wins:
 * (domain, event) → (any domain, event) → (domain, any event) → network default.
 */
export async function resolvePolicy(domain: string | undefined, eventType: string | undefined): Promise<PolicyRow | null> {
  const d = domain ?? null;
  const e = eventType ?? null;
  const domainMatch = d === null ? isNull(notificationPolicy.domain) : or(isNull(notificationPolicy.domain), eq(notificationPolicy.domain, d));
  const eventMatch = e === null ? isNull(notificationPolicy.eventType) : or(isNull(notificationPolicy.eventType), eq(notificationPolicy.eventType, e));
  const rows = await getDb()
    .select()
    .from(notificationPolicy)
    .where(and(eq(notificationPolicy.network, currentNetwork()), eq(notificationPolicy.status, 'active'), domainMatch, eventMatch));
  if (rows.length === 0) return null;
  return rows.sort((a, b) => rank(a) - rank(b))[0]!;
}
