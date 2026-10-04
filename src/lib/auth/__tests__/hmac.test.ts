import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bodyDigest, canonicalString, macMatches, parseSignature, signHmac } from '../hmac';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('hmac v2', () => {
  it('digests the empty body when there is none', () => {
    expect(bodyDigest()).toBe(EMPTY_SHA256);
    expect(bodyDigest(Buffer.alloc(0))).toBe(EMPTY_SHA256);
  });

  it('v2 canonical string ends with the body digest; v1 has none', () => {
    const body = Buffer.from('{"a":1}');
    expect(canonicalString('v2', 'post', '/v1/notify', '100', 'n1', body)).toBe(
      ['POST', '/v1/notify', '100', 'n1', crypto.createHash('sha256').update(body).digest('hex')].join('\n'),
    );
    expect(canonicalString('v1', 'POST', '/notify', '100', 'n1', body)).toBe('POST\n/notify\n100\nn1');
  });

  it('signs and verifies a round trip', () => {
    const c = canonicalString('v2', 'GET', '/providers?x=1', '100', 'n1');
    const header = signHmac('v2', 'secret', c);
    const parsed = parseSignature(header)!;
    expect(parsed.version).toBe('v2');
    expect(macMatches('secret', c, parsed.mac)).toBe(true);
    expect(macMatches('other', c, parsed.mac)).toBe(false);
  });

  it('a v2 MAC over one body does not verify a different body', () => {
    const signed = canonicalString('v2', 'POST', '/v1/notify', '100', 'n1', Buffer.from('{"a":1}'));
    const other = canonicalString('v2', 'POST', '/v1/notify', '100', 'n1', Buffer.from('{"a":2}'));
    const parsed = parseSignature(signHmac('v2', 'secret', signed))!;
    expect(macMatches('secret', signed, parsed.mac)).toBe(true);
    expect(macMatches('secret', other, parsed.mac)).toBe(false);
  });

  it.each(['v3=' + 'a'.repeat(64), 'v2=' + 'A'.repeat(64), 'v2=' + 'a'.repeat(63), 'v2=zz', 'v2', ''])(
    'rejects malformed signature header %j',
    (h) => expect(parseSignature(h)).toBeNull(),
  );
});
