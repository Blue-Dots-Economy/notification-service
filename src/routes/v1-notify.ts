import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Job } from 'src/types';
import { recordAcceptedMany } from '../lib/audit/store';
import { toAcceptedRecord } from '../lib/audit/redact';
import { stamp } from '../lib/audit/stamp';
import { contentRefsFor } from '../lib/content/refs';
import { correlationIdFrom } from '../lib/correlation';
import { describeDbError } from '../lib/db/errors';
import { dedupe, releaseDedupe } from '../lib/dedupe';
import * as metrics from '../lib/metrics';
import { currentNetwork, NetworkNotConfigured } from '../lib/network';
import { notifyBodyLimitBytes } from '../lib/providers/email/attachments';
import { pushManyToPriority } from '../lib/queue';
import { SendError, StoreUnavailable } from '../lib/send/errors';
import { claimIdempotency, completeIdempotency, fallbackKey, releaseIdempotency } from '../lib/send/idempotency';
import { planSend, type SendPlan } from '../lib/send/plan';
import { PRIORITY_MAP, V1NotifySchema, type V1Request } from '../lib/send/request';
import { principalLabel } from '../lib/auth/principal';
import { authenticate } from '../plugins/auth';


const FALLBACK_TTL_S = 5;

function buildJobs(req: V1Request, plan: SendPlan, correlationHeader: unknown): Job[] {
  const eventId = randomUUID();
  const createdAt = new Date().toISOString();
  // A correlation_id in the body wins over the x-correlation-id header.
  const correlationId = correlationIdFrom(req.correlation_id || correlationHeader, eventId);
  const priority = PRIORITY_MAP[req.priority];
  const email =
    req.cc || req.reply_to || req.attachments
      ? { cc: req.cc, replyTo: req.reply_to, attachments: req.attachments }
      : undefined;
  const recipients: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.to)) if (typeof v === 'string') recipients[k] = v;
  // Plan-wide, like recipients: in `all` mode the event row is written from
  // the first job, so every job carries every channel's refs and the
  // delivering attempt's channel picks its entry.
  const contentRefs = contentRefsFor(plan.deliveries);
  const make = (deliveries: SendPlan['deliveries']): Job => ({
    job_id: randomUUID(),
    channel: deliveries[0]!.channel,
    priority,
    to: deliveries[0]!.to,
    template_id: deliveries[0]!.templateKey,
    // Redacted sends carry no values anywhere the audit layer can see.
    variables: plan.redact ? {} : plan.variables,
    ...(plan.deadline !== undefined ? { deadline: plan.deadline } : {}),
    v1: {
      mode: plan.mode,
      deliveries,
      index: 0,
      // Email extras ride only on a job that can deliver by email.
      ...(email && deliveries.some((d) => d.channel === 'email') ? { email } : {}),
    },
    audit: {
      eventId,
      attemptId: randomUUID(),
      createdAt,
      correlationId,
      redactValues: plan.redact,
      deliveryMode: plan.mode,
      recipients,
      ...(plan.redact ? { variableNames: Object.keys(plan.variables) } : {}),
      ...contentRefs,
      ...(req.event_type ? { eventType: req.event_type } : {}),
      ...(req.domain ? { domain: req.domain } : {}),
    },
  });
  return plan.mode === 'all' ? plan.deliveries.map((d) => make([d])) : [make(plan.deliveries)];
}

export async function v1NotifyRoutes(app: FastifyInstance) {
  app.route({
    url: '/v1/notify',
    method: 'POST',
    preHandler: authenticate({ scope: 'notify:send' }),
    bodyLimit: notifyBodyLimitBytes(),
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = V1NotifySchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send(z.formatError(parsed.error));
      const body = parsed.data;

      let network: string;
      try {
        network = currentNetwork();
      } catch (e) {
        if (e instanceof NetworkNotConfigured) return reply.code(503).send({ error: 'network_not_configured' });
        throw e;
      }
      const priority = PRIORITY_MAP[body.priority];

      // Claim first, so a repeat never plans or sends twice.
      let releaseOnce: () => Promise<void>;
      if (body.idempotency_key) {
        let claim: Awaited<ReturnType<typeof claimIdempotency>>;
        try {
          claim = await claimIdempotency(network, body.idempotency_key, priority);
        } catch (err) {
          // Nothing was claimed (or the claim is unknown), so there is nothing to release.
          req.log.error({ err: describeDbError(err) }, 'idempotency claim failed; refusing send');
          return reply.code(503).send({ error: 'idempotency_store_unavailable' });
        }
        if (claim.status === 'replay') return reply.code(200).send(claim.response);
        if (claim.status === 'in_progress') return reply.code(409).send({ error: 'idempotency_in_progress' });
        if (claim.status === 'priority_mismatch')
          return reply.code(409).send({ error: 'idempotency_key_priority_mismatch' });
        releaseOnce = () => releaseIdempotency(network, body.idempotency_key!, priority);
      } else {
        const key = fallbackKey(body);
        let fresh: boolean;
        try {
          fresh = await dedupe(key, FALLBACK_TTL_S);
        } catch (err) {
          req.log.error({ err: describeDbError(err) }, 'duplicate guard failed; refusing send');
          return reply.code(503).send({ error: 'idempotency_store_unavailable' });
        }
        if (!fresh) return reply.code(409).send({ error: 'duplicate-fallback' });
        releaseOnce = () =>
          releaseDedupe(key).catch((e) => req.log.error({ err: (e as Error)?.message ?? String(e) }, 'dedupe release failed'));
      }
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        await releaseOnce();
      };

      try {
        let plan: SendPlan;
        try {
          plan = await planSend(body);
        } catch (e) {
          await release();
          if (e instanceof RangeError) return reply.code(400).send({ error: 'invalid_deadline', message: e.message });
          if (e instanceof StoreUnavailable) return reply.code(503).send({ error: 'template store unavailable' });
          if (e instanceof SendError) {
            await metrics.incr('ns_send_rejected_total', { kind: e.kind, code: e.code });
            return reply.code(422).send({
              error: e.code,
              kind: e.kind,
              message: e.message,
              ...(e.details ? { details: e.details } : {}),
            });
          }
          throw e;
        }

        const jobs = buildJobs(body, plan, req.headers['x-correlation-id']);
        const source = principalLabel(req.principal);
        const records = jobs.map((j) => toAcceptedRecord(j, source));
        const eventId = jobs[0]!.audit!.eventId;

        if (priority === 'realtime') {
          // Queue first: a slow or unavailable Postgres must never delay an OTP.
          await pushManyToPriority(jobs);
          void recordAcceptedMany(records).catch((err) =>
            req.log.error({ err: describeDbError(err), event: eventId }, 'v1 urgent audit insert failed'),
          );
        } else {
          try {
            await recordAcceptedMany(records);
          } catch (err) {
            req.log.error({ err: describeDbError(err), event: eventId }, 'v1 audit insert failed; refusing send');
            await release();
            return reply.code(503).send({ error: 'audit store unavailable' });
          }
          try {
            await pushManyToPriority(jobs);
          } catch (err) {
            for (const job of jobs) await stamp(job, { status: 'failed', attemptNo: 1, error: 'enqueue failed' });
            throw err;
          }
        }

        const response = {
          notification_event_id: eventId,
          correlation_id: jobs[0]!.audit!.correlationId,
          status: 'accepted',
          mode: plan.mode,
          deliveries: plan.deliveries.map((d) => ({ channel: d.channel })),
        };
        if (body.idempotency_key) {
          // One retry. If both fail the send still stands (it is queued); the
          // claim stays pending, so a repeat answers 409 idempotency_in_progress
          // until the 15-minute claim window passes and the key is reclaimable.
          const complete = () => completeIdempotency(network, body.idempotency_key!, priority, response);
          await complete()
            .catch(() => complete())
            .catch((err) => req.log.error({ err: describeDbError(err), event: eventId }, 'idempotency completion failed'));
        }
        released = true; // accepted: the claim now stands
        return reply.code(202).send(response);
      } catch (err) {
        await release(); // enqueue failure or any unexpected error: never strand the claim
        throw err;
      }
    },
  });
}
