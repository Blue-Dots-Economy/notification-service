import { withContent } from '../content/inject';
import type { ContentRef } from '../content/types';
import type { DeliveryMode } from '../db/partitioned';
import type { TemplateRow } from '../db/schema';
import { urgentDefaultDeadlineS } from '../deadline';
import { CHANNEL_CONTACT, planDelivery } from '../policies/plan';
import { callerVariables } from '../templates/contract';
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
  /** Shared content this delivery carries: references, never values. */
  contentRefs: ContentRef[];
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
  let policyChannels: { channel: string; template_key: string }[] = [];
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
    policyChannels = policy.channels;
  }

  let firstConfigError: SendError | undefined;
  const skip = (e: TemplateError) => {
    if (mode === 'single') throw toSendError(e);
    firstConfigError ??= toSendError(e);
  };

  const resolved: { channel: string; key: string; template: TemplateRow; renders: 'ns' | 'provider' }[] = [];
  // Every resolution attempt, keyed by channel and template, so no template is resolved twice.
  const attempted = new Map<string, TemplateRow | null>();
  const slot = (channel: string, key: string) => `${channel}\u0000${key}`;
  for (const c of candidates) {
    try {
      const { template, renders } = await cachedResolveTemplate(c.channel, c.template_key, req.locale);
      attempted.set(slot(c.channel, c.template_key), template);
      resolved.push({ channel: c.channel, key: c.template_key, template, renders });
    } catch (e) {
      attempted.set(slot(c.channel, c.template_key), null);
      if (!(e instanceof TemplateError)) throw e;
      if (classify(e.code) === 'caller') throw toSendError(e);
      skip(e);
    }
  }
  if (resolved.length === 0) throw firstConfigError ?? new SendError('no_reachable_channel', 'nothing to send');

  // Content variables are filled by NS, never the caller: naming one is unknown_variable.
  // For an event the union spans every template the policy names, so a send that reaches only
  // some channels may still carry the others' variables. A template that cannot resolve adds nothing.
  const contract: TemplateRow[] = resolved.map((r) => r.template);
  for (const c of policyChannels) {
    const k = slot(c.channel, c.template_key);
    if (attempted.has(k)) {
      const t = attempted.get(k);
      if (t && !resolved.some((r) => r.template === t)) contract.push(t);
      continue;
    }
    try {
      const { template } = await cachedResolveTemplate(c.channel, c.template_key, req.locale);
      attempted.set(k, template);
      contract.push(template);
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      attempted.set(k, null);
    }
  }
  const union = new Set(contract.flatMap((t) => callerVariables(t.variables).map((s) => s.name)));
  const unknown = Object.keys(req.variables).filter((k) => !union.has(k));
  if (unknown.length) throw new SendError('unknown_variable', `unknown variables: ${unknown.join(', ')}`, { variables: unknown });

  const deliveries: PlannedDelivery[] = [];
  const variables: Record<string, string> = {};
  for (const r of resolved) {
    const own = new Set(callerVariables(r.template.variables).map((s) => s.name));
    let rendered: Rendered;
    let refs: ContentRef[];
    try {
      const content = withContent(r.template, pick(req.variables, own));
      const out = renderWithValues(r.template, r.renders, content.input);
      rendered = out.rendered;
      refs = content.refs;
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
      contentRefs: refs,
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
