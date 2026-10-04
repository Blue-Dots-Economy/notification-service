import { describe, expect, it, vi } from 'vitest';
vi.mock('../../providers', () => ({ providers: {} }));
import { openApiDocument } from '../openapi';

describe('openApiDocument', () => {
  it('documents the admin API with an admin security requirement', () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, { security?: unknown[] }>> };
    for (const path of [
      '/v1/admin/templates', '/v1/admin/templates/{id}', '/v1/admin/templates/{id}/publish',
      '/v1/admin/templates/{id}/retire', '/v1/admin/templates/{id}/preview',
      '/v1/admin/policies', '/v1/admin/policies/{id}', '/v1/admin/policies/{id}/publish', '/v1/admin/policies/{id}/retire',
    ]) {
      expect(doc.paths[path], path).toBeDefined();
      for (const op of Object.values(doc.paths[path]!)) {
        expect(op.security).toEqual([{ requestSignature: [], adminKey: [] }]);
      }
    }
  });

  it('documents POST /v1/notify', () => {
    const doc = openApiDocument() as { paths: Record<string, any> };
    const op = doc.paths['/v1/notify']?.post;
    expect(op).toBeDefined();
    expect(op.security).toEqual([{ requestSignature: [] }]);
    const schema = op.requestBody.content['application/json'].schema;
    expect(schema.additionalProperties).toBe(false);
    for (const k of ['event_type', 'template_key', 'channel', 'to', 'priority']) expect(schema.properties[k], k).toBeDefined();
    expect(schema.properties.priority.enum).toEqual(['urgent', 'normal', 'bulk']);
    for (const code of ['200', '202', '400', '401', '409', '422', '503']) expect(op.responses[code], code).toBeDefined();
    expect(schema.properties.correlation_id.maxLength).toBe(128);
    expect(Object.keys(schema.properties.attachments.items.properties)).toEqual(['filename', 'contentType', 'data']);
    expect(op.responses['422'].content['application/json'].schema.properties.kind.enum).toEqual(['caller', 'configuration']);
  });
});
