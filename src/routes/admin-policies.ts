import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PolicyRow } from '../lib/db/schema';
import * as repo from '../lib/policies/repo';
import { principalLabel } from '../lib/auth/principal';
import { authenticate } from '../plugins/auth';
import { sendAdminError } from './admin-errors';
import { clearResolveCache } from '../lib/send/resolver-cache';

// Slug requires at least one character, so an empty string can never collide with NULL
// under the DB's coalesce-based unique indexes.
const Slug = (max: number) => z.string().regex(/^[a-z0-9_.-]+$/).max(max);
const Channels = z.array(z.object({ channel: z.string().min(1).max(32), template_key: Slug(128) }).strict()).max(10);
const Mode = z.enum(['first_available', 'all']);

const CreateSchema = z
  .object({ domain: Slug(64).nullable().optional(), event_type: Slug(64).nullable().optional(), mode: Mode, channels: Channels })
  .strict();
const PatchSchema = z.object({ mode: Mode.optional(), channels: Channels.optional() }).strict();
const ListQuery = z.object({ domain: z.string().optional(), event_type: z.string().optional(), status: z.enum(['draft', 'active', 'retired']).optional() });
const IdParams = z.object({ id: z.uuid() });

export function serializePolicy(p: PolicyRow) {
  return {
    id: p.id, network: p.network, domain: p.domain, event_type: p.eventType, version: p.version,
    status: p.status, mode: p.mode, channels: p.channels, created_by: p.createdBy,
    published_by: p.publishedBy, created_at: p.createdAt, updated_at: p.updatedAt,
    published_at: p.publishedAt, retired_at: p.retiredAt,
  };
}

export async function adminPolicyRoutes(app: FastifyInstance) {
  const preHandler = authenticate({ scope: 'templates:admin' });

  app.get('/v1/admin/policies', { preHandler }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send(z.formatError(q.error));
    try {
      const rows = await repo.listPolicies({ domain: q.data.domain, eventType: q.data.event_type, status: q.data.status });
      return { policies: rows.map(serializePolicy) };
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.get('/v1/admin/policies/:id', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try { return serializePolicy(await repo.getPolicy(p.data.id)); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/policies', { preHandler }, async (req, reply) => {
    const b = CreateSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    try {
      const row = await repo.createPolicyDraft(
        { domain: b.data.domain, eventType: b.data.event_type, mode: b.data.mode, channels: b.data.channels },
        principalLabel(req.principal),
      );
      return reply.code(201).send(serializePolicy(row));
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.patch('/v1/admin/policies/:id', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const b = PatchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    if (!b.success) return reply.code(400).send(z.formatError(b.error));
    try { return serializePolicy(await repo.updatePolicyDraft(p.data.id, b.data)); }
    catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/policies/:id/publish', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try {
      const row = await repo.publishPolicy(p.data.id, principalLabel(req.principal));
      clearResolveCache(); // this pod sees the change now; others within the cache TTL
      return serializePolicy(row);
    } catch (err) { return sendAdminError(reply, err); }
  });

  app.post('/v1/admin/policies/:id/retire', { preHandler }, async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send(z.formatError(p.error));
    try {
      const row = await repo.retirePolicy(p.data.id);
      clearResolveCache(); // this pod sees the change now; others within the cache TTL
      return serializePolicy(row);
    } catch (err) { return sendAdminError(reply, err); }
  });
}
