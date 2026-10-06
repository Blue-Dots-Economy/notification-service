import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bodyDigest, canonicalString, macMatches, parseSignature, signHmac } from '../hmac';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('hmac v2', () => {
  it('digests the empty body when there is none', () => {
    expect(bodyDigest()).toBe(EMPTY_SHA256);
    expect(bodyDigest(Buffer.alloc(0))).toBe(EMPTY_SHA256);
  });

  it('the canonical string always ends with the body digest', () => {
    const body = Buffer.from('{"a":1}');
    expect(canonicalString('post', '/v1/notify', '100', 'n1', body)).toBe(
      ['POST', '/v1/notify', '100', 'n1', crypto.createHash('sha256').update(body).digest('hex')].join('\n'),
    );
    expect(canonicalString('GET', '/providers', '100', 'n1')).toBe(['GET', '/providers', '100', 'n1', EMPTY_SHA256].join('\n'));
  });

  it('signs and verifies a round trip', () => {
    const c = canonicalString('GET', '/providers?x=1', '100', 'n1');
    const header = signHmac('secret', c);
    expect(header).toMatch(/^v2=[0-9a-f]{64}$/);
    const parsed = parseSignature(header)!;
    expect(macMatches('secret', c, parsed.mac)).toBe(true);
    expect(macMatches('other', c, parsed.mac)).toBe(false);
  });

  it('a v2 MAC over one body does not verify a different body', () => {
    const signed = canonicalString('POST', '/v1/notify', '100', 'n1', Buffer.from('{"a":1}'));
    const other = canonicalString('POST', '/v1/notify', '100', 'n1', Buffer.from('{"a":2}'));
    const parsed = parseSignature(signHmac('secret', signed))!;
    expect(macMatches('secret', signed, parsed.mac)).toBe(true);
    expect(macMatches('secret', other, parsed.mac)).toBe(false);
  });

  it('accepts v2=<64 lowercase hex> only', () => {
    expect(parseSignature('v2=' + 'a'.repeat(64))).not.toBeNull();
    expect(parseSignature('v1=' + 'a'.repeat(64))).toBeNull();
  });

  it.each(['v1=' + 'a'.repeat(64), 'v3=' + 'a'.repeat(64), 'v2=' + 'A'.repeat(64), 'v2=' + 'a'.repeat(63), 'v2=zz', 'v2', ''])(
    'rejects malformed signature header %j',
    (h) => expect(parseSignature(h)).toBeNull(),
  );
});
