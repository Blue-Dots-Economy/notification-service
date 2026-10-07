import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TemplateRow } from '../lib/db/schema';
import { TemplatePatchSchema as PatchSchema, TemplateCreateSchema as CreateSchema } from '../lib/catalogue/schema';
import { withContent } from '../lib/content/inject';
import { renderTemplate } from '../lib/templates/render';
import * as repo from '../lib/templates/repo';
import { channelVendor } from '../lib/templates/vendors';
import { TemplateError } from '../lib/templates/errors';
import { principalLabel } from '../lib/auth/principal';
import { authenticate } from '../plugins/auth';
import { sendAdminError } from './admin-errors';
import { clearResolveCache } from '../lib/send/resolver-cache';

const ListQuery = z.object({
  channel: z.string().optional(),
  template_key: z.string().optional(),
  status: z.enum(['draft', 'active', 'retired']).optional(),
});
const IdParams = z.object({ id: z.uuid() });
const PreviewBody = z.object({ variables: z.record(z.string(), z.unknown()).default({}) }).strict();

function toPatch(b: z.infer<typeof PatchSchema>): repo.TemplatePatch {
  const map: Record<string, keyof repo.TemplatePatch> = {
    subject: 'subject', body_html: 'bodyHtml', body_text: 'bodyText', variables: 'variables',
    provider_template_id: 'providerTemplateId', sender_id: 'senderId', dlt_entity_id: 'dltEntityId',
    dlt_header_id: 'dltHeaderId', dlt_tag_id: 'dltTagId', approval_ref: 'approvalRef',
    default_deadline_s: 'defaultDeadlineS',
  };
  const out: Record<string, unknown> = {};
  const src = b as Record<string, unknown>;
  for (const [k, field] of Object.entries(map)) {
    if (src[k] !== undefined) out[field] = src[k];
  }
  return out as repo.TemplatePatch;
}

export function serializeTemplate(t: TemplateRow) {
  return {
    id: t.id, network: t.network, channel: t.channel, template_key: t.templateKey, locale: t.locale,
    version: t.version, status: t.status, subject: t.subject, body_html: t.bodyHtml, body_text: t.bodyText,
    variables: t.variables, provider: t.provider, provider_template_id: t.providerTemplateId,
    sender_id: t.senderId, dlt_entity_id: t.dltEntityId, dlt_header_id: t.dltHeaderId, dlt_tag_id: t.dltTagId,
    approval_ref: t.approvalRef, default_deadline_s: t.defaultDeadlineS, created_by: t.createdBy,
    published_by: t.publishedBy, created_at: t.createdAt, updated_at: t.updatedAt,
    published_at: t.publishedAt, retired_at: t.retiredAt,
  };
}

export async function adminTemplateRoutes(app: FastifyInstance) {
  const preHandler = authenticate({ scope: 'templates:admin' });

  app.get('/v1/admin/templates', { preHandler }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send(z.formatError(q.error));
    try {
      const rows = await repo.listTemplates({ channel: q.data.channel, templateKey: q.data.template_key, status: q.data.status });
      return { templates: rows.map(serializeTemplate) };
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.get('/v1/admin/templates/:id', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try { return serializeTemplate(await repo.getTemplate(p.data.id)); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/templates', { preHandler }, async (req, reply) => {
    const b = CreateSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    const { channel, template_key, locale, ...rest } = b.data;
    try {
      const row = await repo.createTemplateDraft(
        { channel, templateKey: template_key, locale, ...toPatch(rest) },
        principalLabel(req.principal),
      );
      return reply.code(201).send(serializeTemplate(row));
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.patch('/v1/admin/templates/:id', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const b = PatchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    try { return serializeTemplate(await repo.updateTemplateDraft(p.data.id, toPatch(b.data))); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/templates/:id/publish', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try {
      const row = await repo.publishTemplate(p.data.id, principalLabel(req.principal));
      clearResolveCache(); // this pod sees the change now; others within the cache TTL
      return serializeTemplate(row);
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/templates/:id/retire', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try {
      const row = await repo.retireTemplate(p.data.id);
      clearResolveCache(); // this pod sees the change now; others within the cache TTL
      return serializeTemplate(row);
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/templates/:id/preview', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const b = PreviewBody.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    try {
      const t = await repo.getTemplate(p.data.id);
      const vendor = channelVendor(t.channel);
      if (!vendor) throw new TemplateError('unknown_channel', `no provider for channel ${t.channel}`);
      return { rendered: renderTemplate(t, vendor.renders, withContent(t, b.data.variables).input) };
    } catch (err) { return sendAdminError(reply, err); }
  });
}
