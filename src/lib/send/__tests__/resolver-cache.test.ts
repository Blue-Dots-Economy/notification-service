import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const policies = vi.hoisted(() => ({ resolvePolicy: vi.fn() }));
const templates = vi.hoisted(() => ({ resolveTemplate: vi.fn() }));
vi.mock('../../policies/repo', () => policies);
vi.mock('../../templates/repo', () => templates);

import {
  cachedResolvePolicy,
  cachedResolveTemplate,
  clearResolveCache,
  MAX_ENTRIES,
  resolveCacheSize,
  resolveCacheTtlMs,
} from '../resolver-cache';
import { StoreUnavailable } from '../errors';
import { planSend } from '../plan';
import { V1NotifySchema } from '../request';
import { TemplateError } from '../../templates/errors';

const tpl = { id: 't1', channel: 'sms', templateKey: 'login_otp', locale: 'en', provider: 'msg91', providerTemplateId: 'flow', variables: [], defaultDeadlineS: null };
const hit = { template: tpl, renders: 'provider' as const };
const dbDown = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
const flush = () => new Promise((r) => setImmediate(r));

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.NS_NETWORK = 'blue_dot';
  delete process.env.NS_RESOLVE_CACHE_TTL_MS;
  templates.resolveTemplate.mockReset();
  policies.resolvePolicy.mockReset();
  clearResolveCache();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  errSpy.mockRestore();
});

describe('resolver cache', () => {
  it('a hit is served without a database call', async () => {
    templates.resolveTemplate.mockResolvedValue(hit);
    expect(await cachedResolveTemplate('sms', 'login_otp', 'en')).toBe(hit);
    expect(await cachedResolveTemplate('sms', 'login_otp', 'en')).toBe(hit);
    expect(templates.resolveTemplate).toHaveBeenCalledTimes(1);
  });

  it('keys on every argument, including locale and network', async () => {
    templates.resolveTemplate.mockResolvedValue(hit);
    await cachedResolveTemplate('sms', 'login_otp', 'en');
    await cachedResolveTemplate('sms', 'login_otp', 'hi');
    await cachedResolveTemplate('sms', 'login_otp');
    process.env.NS_NETWORK = 'yellow_dot';
    await cachedResolveTemplate('sms', 'login_otp', 'en');
    expect(templates.resolveTemplate).toHaveBeenCalledTimes(4);
  });

  it('serves the stale entry while one background refresh runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    templates.resolveTemplate.mockResolvedValue(hit);
    await cachedResolveTemplate('sms', 'login_otp');
    vi.setSystemTime(Date.now() + 61_000);
    const fresh = { template: { ...tpl, id: 't2' }, renders: 'provider' as const };
    let finish!: (v: unknown) => void;
    templates.resolveTemplate.mockImplementation(() => new Promise((r) => { finish = r; }));
    expect(await cachedResolveTemplate('sms', 'login_otp')).toBe(hit);
    expect(await cachedResolveTemplate('sms', 'login_otp')).toBe(hit);
    expect(templates.resolveTemplate).toHaveBeenCalledTimes(2); // single-flight: one refresh for both
    finish(fresh);
    await flush();
    expect(await cachedResolveTemplate('sms', 'login_otp')).toBe(fresh);
    expect(templates.resolveTemplate).toHaveBeenCalledTimes(2);
  });

  it('a refresh that fails on the database keeps the stale entry and logs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    templates.resolveTemplate.mockResolvedValue(hit);
    await cachedResolveTemplate('sms', 'login_otp');
    vi.setSystemTime(Date.now() + 61_000);
    templates.resolveTemplate.mockRejectedValue(dbDown());
    expect(await cachedResolveTemplate('sms', 'login_otp')).toBe(hit);
    await flush();
    expect(await cachedResolveTemplate('sms', 'login_otp')).toBe(hit);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('a refresh that finds nothing active drops the entry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    policies.resolvePolicy.mockResolvedValue({ id: 'p1' });
    await cachedResolvePolicy(undefined, 'apply');
    vi.setSystemTime(Date.now() + 61_000);
    policies.resolvePolicy.mockResolvedValue(null);
    await cachedResolvePolicy(undefined, 'apply'); // stale served, refresh started
    await flush();
    expect(await cachedResolvePolicy(undefined, 'apply')).toBeNull();
  });

  it('only positive results are cached', async () => {
    policies.resolvePolicy.mockResolvedValue(null);
    await cachedResolvePolicy('d', 'e');
    await cachedResolvePolicy('d', 'e');
    expect(policies.resolvePolicy).toHaveBeenCalledTimes(2);
    templates.resolveTemplate.mockRejectedValue(new TemplateError('not_found', 'x'));
    await expect(cachedResolveTemplate('sms', 'nope')).rejects.toBeInstanceOf(TemplateError);
    await expect(cachedResolveTemplate('sms', 'nope')).rejects.toBeInstanceOf(TemplateError);
    expect(templates.resolveTemplate).toHaveBeenCalledTimes(2);
  });

  it('a cold miss with the database down is StoreUnavailable', async () => {
    templates.resolveTemplate.mockRejectedValue(dbDown());
    await expect(cachedResolveTemplate('sms', 'login_otp')).rejects.toBeInstanceOf(StoreUnavailable);
    policies.resolvePolicy.mockRejectedValue(dbDown());
    await expect(cachedResolvePolicy(undefined, 'apply')).rejects.toBeInstanceOf(StoreUnavailable);
  });

  it('a warm cache still plans an urgent send with the database down', async () => {
    templates.resolveTemplate.mockResolvedValue(hit);
    const req = V1NotifySchema.parse({ template_key: 'login_otp', channel: 'sms', to: { phone: '+919999999999' }, priority: 'urgent' });
    await planSend(req);
    templates.resolveTemplate.mockRejectedValue(dbDown());
    const plan = await planSend(req);
    expect(plan.deliveries).toHaveLength(1);
    expect(plan.redact).toBe(true);
  });

  it('clear forgets every entry and ignores a refresh that started before it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    templates.resolveTemplate.mockResolvedValue(hit);
    await cachedResolveTemplate('sms', 'login_otp');
    vi.setSystemTime(Date.now() + 61_000);
    let finish!: (v: unknown) => void;
    templates.resolveTemplate.mockImplementation(() => new Promise((r) => { finish = r; }));
    await cachedResolveTemplate('sms', 'login_otp'); // refresh in flight
    clearResolveCache();
    finish({ template: { ...tpl, id: 'old' }, renders: 'provider' });
    await flush();
    expect(resolveCacheSize()).toBe(0);
  });

  it('is bounded, dropping the oldest key first', async () => {
    templates.resolveTemplate.mockResolvedValue(hit);
    for (let i = 0; i <= MAX_ENTRIES; i++) await cachedResolveTemplate('sms', `k${i}`);
    expect(resolveCacheSize()).toBe(MAX_ENTRIES);
    templates.resolveTemplate.mockClear();
    await cachedResolveTemplate('sms', `k${MAX_ENTRIES}`);
    expect(templates.resolveTemplate).not.toHaveBeenCalled();
    await cachedResolveTemplate('sms', 'k0');
    expect(templates.resolveTemplate).toHaveBeenCalledTimes(1);
  });

  it('TTL is env-overridable and validated', () => {
    expect(resolveCacheTtlMs({})).toBe(60_000);
    expect(resolveCacheTtlMs({ NS_RESOLVE_CACHE_TTL_MS: '5000' })).toBe(5000);
    expect(() => resolveCacheTtlMs({ NS_RESOLVE_CACHE_TTL_MS: 'soon' })).toThrow('NS_RESOLVE_CACHE_TTL_MS');
    expect(() => resolveCacheTtlMs({ NS_RESOLVE_CACHE_TTL_MS: '0' })).toThrow('NS_RESOLVE_CACHE_TTL_MS');
  });
});
