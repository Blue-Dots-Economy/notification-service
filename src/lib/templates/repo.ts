import { and, eq, inArray, max, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { template, type LifecycleStatus, type TemplateRow, type VariableSpec } from '../db/schema';
import { currentNetwork, defaultLocale } from '../network';
import { TemplateError } from './errors';
import { validateForPublish } from './validate';
import { channelVendor } from './vendors';

export interface TemplateDraftInput {
  channel: string;
  templateKey: string;
  locale?: string;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  variables?: VariableSpec[];
  providerTemplateId?: string | null;
  senderId?: string | null;
  dltEntityId?: string | null;
  dltHeaderId?: string | null;
  dltTagId?: string | null;
  approvalRef?: string | null;
  defaultDeadlineS?: number | null;
}

export type TemplatePatch = Omit<Partial<TemplateDraftInput>, 'channel' | 'templateKey' | 'locale'>;

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0];

/** Serialise every write to one template key: version numbering and publish. */
async function lockKey(tx: Tx, network: string, channel: string, key: string, locale: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`template:${network}:${channel}:${key}:${locale}`}))`,
  );
}

async function loadForUpdate(tx: Tx, id: string): Promise<TemplateRow> {
  const network = currentNetwork();
  const rows = await tx
    .select()
    .from(template)
    .where(and(eq(template.id, id), eq(template.network, network)))
    .for('update');
  if (!rows[0]) throw new TemplateError('not_found', 'template not found');
  return rows[0];
}

export async function createTemplateDraft(input: TemplateDraftInput, actor: string): Promise<TemplateRow> {
  const network = currentNetwork();
  const vendor = channelVendor(input.channel);
  if (!vendor) throw new TemplateError('unknown_channel', `no provider for channel ${input.channel}`);
  const locale = input.locale ?? defaultLocale();
  return getDb().transaction(async (tx) => {
    await lockKey(tx, network, input.channel, input.templateKey, locale);
    const [{ v }] = await tx
      .select({ v: max(template.version) })
      .from(template)
      .where(
        and(
          eq(template.network, network),
          eq(template.channel, input.channel),
          eq(template.templateKey, input.templateKey),
          eq(template.locale, locale),
        ),
      );
    const [row] = await tx
      .insert(template)
      .values({
        ...input,
        variables: input.variables ?? [],
        locale,
        network,
        provider: vendor.vendor,
        version: (v ?? 0) + 1,
        status: 'draft',
        createdBy: actor,
      })
      .returning();
    return row!;
  });
}

export async function updateTemplateDraft(id: string, patch: TemplatePatch): Promise<TemplateRow> {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, id);
    if (current.status !== 'draft') {
      throw new TemplateError('invalid_state', `only drafts can be edited; this one is ${current.status}`);
    }
    const [row] = await tx
      .update(template)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(template.id, id))
      .returning();
    return row!;
  });
}

export async function publishTemplate(id: string, actor: string): Promise<TemplateRow> {
  return getDb().transaction(async (tx) => {
    const peek = await loadForUpdate(tx, id);
    await lockKey(tx, peek.network, peek.channel, peek.templateKey, peek.locale);
    const current = await loadForUpdate(tx, id);
    if (current.status !== 'draft') {
      throw new TemplateError('invalid_state', `only drafts can be published; this one is ${current.status}`);
    }
    validateForPublish(current, channelVendor(current.channel));
    const now = new Date();
    await tx
      .update(template)
      .set({ status: 'retired', retiredAt: now, updatedAt: now })
      .where(
        and(
          eq(template.network, current.network),
          eq(template.channel, current.channel),
          eq(template.templateKey, current.templateKey),
          eq(template.locale, current.locale),
          eq(template.status, 'active'),
        ),
      );
    const [row] = await tx
      .update(template)
      .set({ status: 'active', publishedAt: now, publishedBy: actor, updatedAt: now })
      .where(eq(template.id, id))
      .returning();
    return row!;
  });
}

export async function retireTemplate(id: string): Promise<TemplateRow> {
  return getDb().transaction(async (tx) => {
    const current = await loadForUpdate(tx, id);
    if (current.status === 'retired') throw new TemplateError('invalid_state', 'already retired');
    const now = new Date();
    const [row] = await tx
      .update(template)
      .set({ status: 'retired', retiredAt: now, updatedAt: now })
      .where(eq(template.id, id))
      .returning();
    return row!;
  });
}

export async function getTemplate(id: string): Promise<TemplateRow> {
  const rows = await getDb()
    .select()
    .from(template)
    .where(and(eq(template.id, id), eq(template.network, currentNetwork())));
  if (!rows[0]) throw new TemplateError('not_found', 'template not found');
  return rows[0];
}

export async function listTemplates(filter: {
  channel?: string;
  templateKey?: string;
  status?: LifecycleStatus;
}): Promise<TemplateRow[]> {
  const conds = [eq(template.network, currentNetwork())];
  if (filter.channel) conds.push(eq(template.channel, filter.channel));
  if (filter.templateKey) conds.push(eq(template.templateKey, filter.templateKey));
  if (filter.status) conds.push(eq(template.status, filter.status));
  return getDb()
    .select()
    .from(template)
    .where(and(...conds))
    .orderBy(template.channel, template.templateKey, template.locale, template.version);
}

function localeChain(requested: string | undefined): string[] {
  const chain: string[] = [];
  if (requested) {
    chain.push(requested);
    const base = requested.split('-')[0]!;
    if (base !== requested) chain.push(base);
  }
  chain.push(defaultLocale());
  return [...new Set(chain)];
}

/**
 * The active template a send would use, with the deployment's render mode.
 * Refuses a template registered for a different vendor than the one this
 * deployment sends through — its ids mean nothing to the current vendor.
 */
export async function resolveTemplate(
  channel: string,
  templateKey: string,
  locale?: string,
): Promise<{ template: TemplateRow; renders: 'ns' | 'provider' }> {
  const vendor = channelVendor(channel);
  if (!vendor) throw new TemplateError('unknown_channel', `no provider for channel ${channel}`);
  const chain = localeChain(locale);
  const rows = await getDb()
    .select()
    .from(template)
    .where(
      and(
        eq(template.network, currentNetwork()),
        eq(template.channel, channel),
        eq(template.templateKey, templateKey),
        eq(template.status, 'active'),
        inArray(template.locale, chain),
      ),
    );
  const found = chain.map((l) => rows.find((r) => r.locale === l)).find(Boolean);
  if (!found) throw new TemplateError('not_found', `no active ${channel} template ${templateKey}`);
  if (found.provider !== vendor.vendor) {
    throw new TemplateError('vendor_mismatch', `active ${templateKey} is for ${found.provider}; ${channel} sends via ${vendor.vendor}`);
  }
  return { template: found, renders: vendor.renders };
}

export async function hasActiveTemplate(channel: string, templateKey: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: template.id })
    .from(template)
    .where(
      and(
        eq(template.network, currentNetwork()),
        eq(template.channel, channel),
        eq(template.templateKey, templateKey),
        eq(template.status, 'active'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Whether any row (any status) exists for this key, locale and vendor in the current network. */
export async function templateRowExists(channel: string, templateKey: string, locale: string, provider: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: template.id })
    .from(template)
    .where(
      and(
        eq(template.network, currentNetwork()),
        eq(template.channel, channel),
        eq(template.templateKey, templateKey),
        eq(template.locale, locale),
        eq(template.provider, provider),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
