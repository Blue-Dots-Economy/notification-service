/**
 * In-memory stand-in for the ioredis client in `src/lib/redis.ts`.
 *
 * Implements only the commands this service actually uses, with the same return
 * shapes ioredis produces — including the ones that are easy to get wrong:
 * `set(..., 'NX')` returns `'OK'` or `null`, `brpop` returns `[key, value]` or
 * `null`, and `multi().exec()` returns `[error, result]` pairs.
 *
 * A fake rather than a Docker-backed Redis so the suite runs anywhere (including
 * environments without Docker) in milliseconds. The tradeoff is deliberate: it
 * verifies our logic, not Redis's — anything that depends on real Redis semantics
 * (notably the non-atomic read-then-delete in `popScheduledRetries`, see #50)
 * needs an integration test against a real server.
 */
type ZEntry = { member: string; score: number };

export class RedisFake {
  lists = new Map<string, string[]>();
  zsets = new Map<string, ZEntry[]>();
  strings = new Map<string, { value: string; expiresAt?: number }>();

  private list(key: string): string[] {
    if (!this.lists.has(key)) this.lists.set(key, []);
    return this.lists.get(key)!;
  }

  private zset(key: string): ZEntry[] {
    if (!this.zsets.has(key)) this.zsets.set(key, []);
    return this.zsets.get(key)!;
  }

  /** LPUSH — pushes onto the head, so RPOP is FIFO. Returns the new length. */
  async lpush(key: string, value: string): Promise<number> {
    const l = this.list(key);
    l.unshift(value);
    return l.length;
  }

  /** BRPOP — non-blocking here; `[key, value]` when present, else null. */
  async brpop(key: string, _timeoutSeconds: number): Promise<[string, string] | null> {
    const l = this.list(key);
    if (l.length === 0) return null;
    return [key, l.pop()!];
  }

  async rpop(key: string): Promise<string | null> {
    const l = this.list(key);
    return l.length === 0 ? null : l.pop()!;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.list(key);
    return stop === -1 ? l.slice(start) : l.slice(start, stop + 1);
  }

  /** LREM with count=1: removes the first matching element from the head. */
  async lrem(key: string, count: number, value: string): Promise<number> {
    const l = this.list(key);
    let removed = 0;
    for (let i = 0; i < l.length && (count === 0 || removed < count); ) {
      if (l[i] === value) {
        l.splice(i, 1);
        removed += 1;
      } else {
        i += 1;
      }
    }
    return removed;
  }

  async llen(key: string): Promise<number> {
    return this.list(key).length;
  }

  /** SET key value EX ttl NX — `'OK'` on success, null when the key exists. */
  async set(
    key: string,
    value: string,
    _ex: 'EX',
    ttlSeconds: number,
    mode: 'NX',
  ): Promise<'OK' | null> {
    const existing = this.strings.get(key);
    const live =
      existing && (existing.expiresAt === undefined || existing.expiresAt > Date.now());
    if (mode === 'NX' && live) return null;
    this.strings.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return 'OK';
  }

  async zadd(key: string, score: string | number, member: string): Promise<number> {
    const z = this.zset(key);
    const existing = z.find((e) => e.member === member);
    if (existing) {
      existing.score = Number(score);
      return 0;
    }
    z.push({ member, score: Number(score) });
    return 1;
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return this.zset(key)
      .filter((e) => e.score >= min && e.score <= max)
      .sort((a, b) => a.score - b.score)
      .map((e) => e.member);
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<number> {
    const z = this.zset(key);
    const before = z.length;
    const kept = z.filter((e) => !(e.score >= min && e.score <= max));
    this.zsets.set(key, kept);
    return before - kept.length;
  }

  async zcard(key: string): Promise<number> {
    return this.zset(key).length;
  }

  /** ZRANGE with WITHSCORES returns a flat [member, score, ...] string array. */
  async zrange(
    key: string,
    start: number,
    stop: number,
    withScores?: 'WITHSCORES',
  ): Promise<string[]> {
    const sorted = this.zset(key).sort((a, b) => a.score - b.score);
    const slice = stop === -1 ? sorted.slice(start) : sorted.slice(start, stop + 1);
    if (!withScores) return slice.map((e) => e.member);
    return slice.flatMap((e) => [e.member, String(e.score)]);
  }

  /** MULTI — queues calls, then `exec()` resolves to ioredis's [err, result] pairs. */
  multi() {
    const queued: Array<() => Promise<unknown>> = [];
    const chain = {
      llen: (key: string) => {
        queued.push(() => this.llen(key));
        return chain;
      },
      zcard: (key: string) => {
        queued.push(() => this.zcard(key));
        return chain;
      },
      zrange: (key: string, start: number, stop: number, withScores?: 'WITHSCORES') => {
        queued.push(() => this.zrange(key, start, stop, withScores));
        return chain;
      },
      exec: async () => {
        const out: Array<[Error | null, unknown]> = [];
        for (const fn of queued) out.push([null, await fn()]);
        return out;
      },
    };
    return chain;
  }
}
