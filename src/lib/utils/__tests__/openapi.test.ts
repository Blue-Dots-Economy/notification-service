import { describe, expect, it, vi } from 'vitest';
vi.mock('../../providers', () => ({ providers: {} }));
import { CONTENT_KEY } from '../../templates/contract';
import { openApiDocument } from '../openapi';

const SEND_SECURITY = [{ requestSignature: [] }, { bearerAuth: ['notify:send'] }];
const ADMIN_SECURITY = [{ requestSignature: [] }, { bearerAuth: ['templates:admin'] }];

describe('openApiDocument', () => {
  it('documents the admin API with an admin security requirement', () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    for (const path of [
      '/v1/admin/templates', '/v1/admin/templates/{id}', '/v1/admin/templates/{id}/publish',
      '/v1/admin/templates/{id}/retire', '/v1/admin/templates/{id}/preview',
      '/v1/admin/policies', '/v1/admin/policies/{id}', '/v1/admin/policies/{id}/publish', '/v1/admin/policies/{id}/retire',
      '/v1/admin/export',
    ]) {
      expect(doc.paths[path], path).toBeDefined();
      for (const op of Object.values(doc.paths[path]!)) {
        expect(op.security).toEqual(ADMIN_SECURITY);
        expect(op.responses['401'], path).toBeDefined();
        expect(op.responses['403'], path).toBeDefined();
      }
    }
  });

  it('documents GET /v1/admin/export with admin security and 200/401/403/503', () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, { security?: unknown[]; responses: Record<string, unknown> }>> };
    const op = doc.paths['/v1/admin/export']!.get!;
    expect(op.security).toEqual(ADMIN_SECURITY);
    for (const code of ['200', '401', '403', '503']) expect(op.responses[code], code).toBeDefined();
  });

  it('declares the bearer and HMAC v2 security schemes, and no adminKey scheme', () => {
    const doc = openApiDocument() as { openapi: string; components: { securitySchemes: Record<string, any> } };
    const schemes = doc.components.securitySchemes;
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(schemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(schemes.requestSignature.description).toContain('v2');
    expect(schemes.requestSignature.description).toContain('METHOD\\npath\\ntimestamp\\nnonce\\nsha256(body)');
    expect(schemes.adminKey).toBeUndefined();
    expect(JSON.stringify(doc)).not.toContain('NS_ADMIN_KEY_IDS');
  });

  it('requires templates:admin on POST /failed/retry and notify:send on both send routes', () => {
    const doc = openApiDocument() as { paths: Record<string, any> };
    expect(doc.paths['/failed/retry'].post.security).toEqual(ADMIN_SECURITY);
    expect(doc.paths['/failed/retry'].post.responses['403']).toBeDefined();
    for (const path of ['/v1/notify', '/notify']) {
      const op = doc.paths[path].post;
      expect(op.security).toEqual(SEND_SECURITY);
      expect(op.responses['401'], path).toBeDefined();
      expect(op.responses['403'], path).toBeDefined();
    }
    for (const path of ['/providers', '/providers/{name}', '/metrics/queue']) {
      const op = doc.paths[path].get;
      expect(op.security).toEqual([{ requestSignature: [] }, { bearerAuth: [] }]);
      expect(op.responses['401'], path).toBeDefined();
    }
  });

  it('documents POST /v1/notify', () => {
    const doc = openApiDocument() as { paths: Record<string, any> };
    const op = doc.paths['/v1/notify']?.post;
    expect(op).toBeDefined();
    expect(op.security).toEqual(SEND_SECURITY);
    const schema = op.requestBody.content['application/json'].schema;
    expect(schema.additionalProperties).toBe(false);
    for (const k of ['event_type', 'template_key', 'channel', 'to', 'priority']) expect(schema.properties[k], k).toBeDefined();
    expect(schema.properties.priority.enum).toEqual(['urgent', 'normal', 'bulk']);
    for (const code of ['200', '202', '400', '401', '403', '409', '422', '503']) expect(op.responses[code], code).toBeDefined();
    expect(schema.properties.correlation_id.maxLength).toBe(128);
    expect(Object.keys(schema.properties.attachments.items.properties)).toEqual(['filename', 'contentType', 'data']);
    expect(op.responses['422'].content['application/json'].schema.properties.kind.enum).toEqual(['caller', 'configuration']);
  });

  it('every bearer-capable operation documents the 503 for an unreachable Keycloak key set', () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, any>>; components: { securitySchemes: Record<string, any> } };
    let checked = 0;
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const op of Object.values(ops)) {
        if (!op.security?.some((s: Record<string, unknown>) => 'bearerAuth' in s)) continue;
        expect(op.responses['503']?.description, path).toMatch(/Keycloak key set could not be reached/);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
    expect(doc.components.securitySchemes.bearerAuth.description).toContain('the configured audience (default `notification-service`)');
  });

  it('documents content_ref variables and their error codes', () => {
    const doc = openApiDocument() as { components: { schemas: Record<string, any> }; paths: Record<string, any> };
    const props = doc.components.schemas.VariableSpec.properties;
    expect(props.source.enum).toEqual(['request', 'content_ref']);
    expect(props.contentKey.pattern).toBe(CONTENT_KEY.source);
    const codes = ['content_unavailable', 'unknown_content_key', 'content_unresolved', 'invalid_content'];
    const admin = doc.paths['/v1/admin/templates'].post.responses['422'].description as string;
    const notify = doc.paths['/v1/notify'].post.responses['422'].description as string;
    for (const c of codes) {
      expect(admin, c).toContain(c);
      expect(notify, c).toContain(c);
    }
    expect(notify).toMatch(/configuration.*content_unavailable/);
  });
});
