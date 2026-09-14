import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisFake } from './redis-fake';

const redis = new RedisFake();
vi.mock('../redis', () => ({ default: redis }));

const { incr, renderPrometheus, setGauge } = await import('../metrics');

const EMPTY_QUEUE = {
  realtime: 0,
  other: 0,
  retry_count: 0,
  retry_oldest: null,
  retry_eta_seconds: null,
  dlq: 0,
};

beforeEach(async () => {
  await redis.flushall?.();
});

describe('counters', () => {
  it('accumulates across calls, so the worker and API see one total', async () => {
    await incr('ns_sms_send_total', { provider: 'pinnacle', result: 'ok' });
    await incr('ns_sms_send_total', { provider: 'pinnacle', result: 'ok' });

    expect(await renderPrometheus(EMPTY_QUEUE)).toContain(
      'ns_sms_send_total{provider="pinnacle",result="ok"} 2'
    );
  });

  it('keeps distinct label sets on distinct series', async () => {
    await incr('ns_sms_send_total', { provider: 'pinnacle', result: 'ok' });
    await incr('ns_sms_send_total', { provider: 'pinnacle', result: 'failed' });

    const out = await renderPrometheus(EMPTY_QUEUE);
    expect(out).toContain('ns_sms_send_total{provider="pinnacle",result="failed"} 1');
    expect(out).toContain('ns_sms_send_total{provider="pinnacle",result="ok"} 1');
  });

  it('emits one HELP/TYPE pair per metric name, not per series', async () => {
    await incr('ns_sms_send_total', { provider: 'pinnacle', result: 'ok' });
    await incr('ns_sms_send_total', { provider: 'msg91', result: 'ok' });

    const out = await renderPrometheus(EMPTY_QUEUE);
    expect(out.match(/# TYPE ns_sms_send_total /g)).toHaveLength(1);
  });

  it('records provider error codes so EC1003 is distinguishable from EC1013', async () => {
    await incr('ns_sms_provider_error_total', { provider: 'pinnacle', code: 'EC1003' });

    expect(await renderPrometheus(EMPTY_QUEUE)).toContain(
      'ns_sms_provider_error_total{code="EC1003",provider="pinnacle"} 1'
    );
  });

  it('never throws when Redis is unavailable — metrics must not fail a send', async () => {
    const boom = vi.spyOn(redis, 'hincrby').mockRejectedValueOnce(new Error('down'));
    await expect(incr('ns_sms_send_total', { provider: 'pinnacle', result: 'ok' })).resolves
      .toBeUndefined();
    boom.mockRestore();
  });
});

describe('gauges', () => {
  it('exposes the last written balance', async () => {
    await setGauge('ns_provider_balance', 4200, { provider: 'pinnacle' });

    expect(await renderPrometheus(EMPTY_QUEUE)).toContain(
      'ns_provider_balance{provider="pinnacle"} 4200'
    );
  });

  it('overwrites rather than accumulating', async () => {
    await setGauge('ns_provider_balance', 4200, { provider: 'pinnacle' });
    await setGauge('ns_provider_balance', 4100, { provider: 'pinnacle' });

    const out = await renderPrometheus(EMPTY_QUEUE);
    expect(out).toContain('ns_provider_balance{provider="pinnacle"} 4100');
    expect(out).not.toContain('4200');
  });
});

describe('queue depths', () => {
  it('reads live rather than from a stored counter', async () => {
    const out = await renderPrometheus({ ...EMPTY_QUEUE, dlq: 7, realtime: 3 });

    expect(out).toContain('ns_queue_depth{queue="dlq"} 7');
    expect(out).toContain('ns_queue_depth{queue="realtime"} 3');
  });

  it('omits a null retry eta rather than emitting NaN', async () => {
    expect(await renderPrometheus(EMPTY_QUEUE)).not.toContain('ns_retry_eta_seconds');
  });
});
