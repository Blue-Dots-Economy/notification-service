import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, errors } from 'jose';
import { bearerConfig, setKeyResolverForTests, verifyBearer, type BearerConfig } from '../bearer';

const ISS = 'https://kc.example/auth/realms/bluedots';
const cfg: BearerConfig = {
  issuer: ISS,
  jwksUri: `${ISS}/protocol/openid-connect/certs`,
  audience: 'notification-service',
  allowedAzp: new Set(['signals-api']),
};

let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' };
  setKeyResolverForTests(createLocalJWKSet({ keys: [jwk] }));
});
afterEach(() => undefined);

function token(claims: Record<string, unknown>, opts: { exp?: string | number; iss?: string } = {}) {
  return new SignJWT({ typ: 'Bearer', azp: 'signals-api', client_id: 'signals-api', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? ISS)
    .setSubject('sa-uuid')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);
}
const nsRoles = (roles: string[]) => ({ resource_access: { 'notification-service': { roles } } });

describe('verifyBearer', () => {
  it('accepts a service-account token and maps NS client roles to scopes', async () => {
    const res = await verifyBearer(await token({ aud: ['signals-api', 'notification-service'], ...nsRoles(['notify:send', 'uma_protection']) }), cfg);
    expect(res).toMatchObject({ ok: true, principal: { kind: 'bearer', id: 'signals-api' } });
    if (res.ok) expect([...res.principal.scopes]).toEqual(['notify:send']);
  });

  it('identifies a person by client and subject', async () => {
    const res = await verifyBearer(await token({ aud: 'notification-service', client_id: undefined, ...nsRoles(['templates:admin']) }), cfg);
    expect(res).toMatchObject({ ok: true, principal: { id: 'signals-api:sa-uuid' } });
  });

  it('ignores roles held on other clients', async () => {
    const res = await verifyBearer(
      await token({ aud: 'notification-service', resource_access: { 'signals-api': { roles: ['templates:admin'] } } }),
      cfg,
    );
    expect(res.ok && res.principal.scopes.size).toBe(0);
  });

  it.each([
    ['audience missing', { aud: 'signals-api' }, 'Token invalid'],
    ['azp not allowlisted', { aud: 'notification-service', azp: 'aggregator-dpg' }, 'Token client not accepted'],
    ['azp absent', { aud: 'notification-service', azp: undefined }, 'Token client not accepted'],
    ['an ID token', { aud: 'notification-service', typ: 'ID' }, 'Token invalid'],
    ['typ absent', { aud: 'notification-service', typ: undefined }, 'Token invalid'],
  ])('rejects %s with 401', async (_name, claims, error) => {
    expect(await verifyBearer(await token(claims), cfg)).toEqual({ ok: false, status: 401, error });
  });

  it('identifies a token whose client_id differs from azp by client and subject', async () => {
    const res = await verifyBearer(await token({ aud: 'notification-service', client_id: 'other' }), cfg);
    expect(res).toMatchObject({ ok: true, principal: { id: 'signals-api:sa-uuid' } });
  });

  it('rejects a token without exp', async () => {
    const t = await new SignJWT({ typ: 'Bearer', azp: 'signals-api', aud: 'notification-service' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISS).setSubject('sa-uuid').setIssuedAt().sign(privateKey);
    expect(await verifyBearer(t, cfg)).toEqual({ ok: false, status: 401, error: 'Token invalid' });
  });

  it('rejects a token without sub', async () => {
    const t = await new SignJWT({ typ: 'Bearer', azp: 'signals-api', aud: 'notification-service' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(ISS).setIssuedAt().setExpirationTime('5m').sign(privateKey);
    expect(await verifyBearer(t, cfg)).toEqual({ ok: false, status: 401, error: 'Token invalid' });
  });

  it('rejects another issuer', async () => {
    const t = await token({ aud: 'notification-service' }, { iss: 'https://kc.example/auth/realms/other' });
    expect(await verifyBearer(t, cfg)).toEqual({ ok: false, status: 401, error: 'Token invalid' });
  });

  it('reports an expired token as expired', async () => {
    const t = await token({ aud: 'notification-service' }, { exp: Math.floor(Date.now() / 1000) - 120 });
    expect(await verifyBearer(t, cfg)).toEqual({ ok: false, status: 401, error: 'Token expired' });
  });

  it('rejects garbage', async () => {
    expect(await verifyBearer('not-a-jwt', cfg)).toEqual({ ok: false, status: 401, error: 'Token invalid' });
  });

  it('answers 503 when the key set cannot be fetched', async () => {
    setKeyResolverForTests(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await verifyBearer(await token({ aud: 'notification-service' }), cfg)).toEqual({
      ok: false, status: 503, error: 'Auth service unavailable',
    });
    setKeyResolverForTests(async () => {
      throw new errors.JWKSTimeout();
    });
    expect(await verifyBearer(await token({ aud: 'notification-service' }), cfg)).toEqual({
      ok: false, status: 503, error: 'Auth service unavailable',
    });
    setKeyResolverForTests(async () => {
      throw new errors.JWKSInvalid();
    });
    expect(await verifyBearer(await token({ aud: 'notification-service' }), cfg)).toEqual({
      ok: false, status: 503, error: 'Auth service unavailable',
    });
  });
});

describe('bearerConfig', () => {
  it('is off without an issuer', () => expect(bearerConfig({})).toBeNull());

  it('derives the JWKS URI and defaults the audience', () => {
    expect(bearerConfig({ NS_KEYCLOAK_ISSUER: ISS, NS_AUTH_ALLOWED_AZP: ' signals-api , ' })).toEqual({
      issuer: ISS,
      jwksUri: `${ISS}/protocol/openid-connect/certs`,
      audience: 'notification-service',
      allowedAzp: new Set(['signals-api']),
    });
  });

  it('requires an azp allowlist when bearer auth is on', () => {
    expect(() => bearerConfig({ NS_KEYCLOAK_ISSUER: ISS })).toThrow(/NS_AUTH_ALLOWED_AZP/);
  });

  it('rejects a trailing slash on the issuer', () => {
    expect(() => bearerConfig({ NS_KEYCLOAK_ISSUER: `${ISS}/`, NS_AUTH_ALLOWED_AZP: 'a' })).toThrow(/trailing slash/);
  });

  it('rejects a non-http JWKS URI', () => {
    expect(() => bearerConfig({ NS_KEYCLOAK_ISSUER: ISS, NS_AUTH_ALLOWED_AZP: 'a', NS_KEYCLOAK_JWKS_URI: 'file:///x' })).toThrow();
  });

  it('rejects a non-http issuer', () => {
    expect(() => bearerConfig({ NS_KEYCLOAK_ISSUER: 'ftp://x/realms/r', NS_AUTH_ALLOWED_AZP: 'a' })).toThrow();
  });

  it('rejects an invalid JWKS URI', () => {
    expect(() => bearerConfig({ NS_KEYCLOAK_ISSUER: ISS, NS_AUTH_ALLOWED_AZP: 'a', NS_KEYCLOAK_JWKS_URI: 'not a url' })).toThrow();
  });
});
