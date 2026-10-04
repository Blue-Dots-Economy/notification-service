import type { DeliveryMode } from '../db/partitioned';
import type { TemplateRow } from '../db/schema';
import { urgentDefaultDeadlineS } from '../deadline';
import { CHANNEL_CONTACT, planDelivery } from '../policies/plan';
import { TemplateError } from '../templates/errors';
import { renderWithValues, type Rendered } from '../templates/render';
import { classify, SendError } from './errors';
import { parseDeadline, type V1Request } from './request';
import { cachedResolvePolicy, cachedResolveTemplate } from './resolver-cache';

export interface PlannedDelivery {
  channel: string;
  to: string;
  templateKey: string;
  provider: string;
  providerTemplateId: string | null;
  rendered: Rendered;
  dlt: { senderId: string | null; dltEntityId: string | null; dltHeaderId: string | null; dltTagId: string | null };
}

export interface SendPlan {
  mode: DeliveryMode;
  deliveries: PlannedDelivery[];
  redact: boolean;
  deadline?: number;
  variables: Record<string, string>;
}

const toSendError = (e: TemplateError) => new SendError(e.code, e.message, e.details);

function pick(input: Record<string, unknown>, names: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(input)) if (names.has(k)) out[k] = input[k];
  return out;
}

/**
 * Turn a v1 request into fully rendered deliveries, before anything is accepted.
 * Caller mistakes fail the request; a misconfigured candidate is skipped when
 * another can carry the message (first_available / all) and fails it otherwise.
 */
export async function planSend(req: V1Request, now = Date.now()): Promise<SendPlan> {
  const deadlineFromRequest = parseDeadline(req.deadline, now);
  const contacts = req.to;

  let mode: DeliveryMode;
  let candidates: { channel: string; template_key: string }[];
  if (req.template_key) {
    const need = CHANNEL_CONTACT[req.channel!];
    if (!need || !contacts[need]) throw new SendError('no_reachable_channel', `no ${need ?? 'contact point'} for ${req.channel}`);
    mode = 'single';
    candidates = [{ channel: req.channel!, template_key: req.template_key }];
  } else {
    const policy = await cachedResolvePolicy(req.domain, req.event_type);
    if (!policy) throw new SendError('no_policy', `no active policy for ${req.event_type}`);
    candidates = planDelivery(policy, contacts).candidates;
    if (candidates.length === 0) throw new SendError('no_reachable_channel', 'no channel in the policy matches the supplied contact points');
    mode = policy.mode;
  }

  let firstConfigError: SendError | undefined;
  const skip = (e: TemplateError) => {
    if (mode === 'single') throw toSendError(e);
    firstConfigError ??= toSendError(e);
  };

  const resolved: { channel: string; key: string; template: TemplateRow; renders: 'ns' | 'provider' }[] = [];
  for (const c of candidates) {
    try {
      const { template, renders } = await cachedResolveTemplate(c.channel, c.template_key, req.locale);
      resolved.push({ channel: c.channel, key: c.template_key, template, renders });
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      if (classify(e.code) === 'caller') throw toSendError(e);
      skip(e);
    }
  }
  if (resolved.length === 0) throw firstConfigError ?? new SendError('no_reachable_channel', 'nothing to send');

  const union = new Set(resolved.flatMap((r) => r.template.variables.map((s) => s.name)));
  const unknown = Object.keys(req.variables).filter((k) => !union.has(k));
  if (unknown.length) throw new SendError('unknown_variable', `unknown variables: ${unknown.join(', ')}`, { variables: unknown });

  const deliveries: PlannedDelivery[] = [];
  const variables: Record<string, string> = {};
  for (const r of resolved) {
    const own = new Set(r.template.variables.map((s) => s.name));
    let rendered: Rendered;
    try {
      const out = renderWithValues(r.template, r.renders, pick(req.variables, own));
      rendered = out.rendered;
      Object.assign(variables, out.values);
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      if (classify(e.code) === 'caller') throw toSendError(e);
      skip(e);
      continue;
    }
    deliveries.push({
      channel: r.channel,
      to: r.channel === 'email' ? contacts.email! : contacts.phone!,
      templateKey: r.key,
      provider: r.template.provider,
      providerTemplateId: r.template.providerTemplateId,
      rendered,
      dlt: {
        senderId: r.template.senderId, dltEntityId: r.template.dltEntityId,
        dltHeaderId: r.template.dltHeaderId, dltTagId: r.template.dltTagId,
      },
    });
  }
  if (deliveries.length === 0) throw firstConfigError ?? new SendError('no_reachable_channel', 'nothing to send');

  const used = resolved.filter((r) => deliveries.some((d) => d.templateKey === r.key && d.channel === r.channel));
  const redact = req.priority === 'urgent' || used.some((r) => r.template.variables.some((s) => s.sensitive));
  const defaults = used.map((r) => r.template.defaultDeadlineS).filter((s): s is number => typeof s === 'number');
  const deadline =
    deadlineFromRequest ??
    (defaults.length ? now + Math.min(...defaults) * 1000 : undefined) ??
    (req.priority === 'urgent' ? now + urgentDefaultDeadlineS() * 1000 : undefined);

  return { mode, deliveries, redact, deadline, variables };
}
