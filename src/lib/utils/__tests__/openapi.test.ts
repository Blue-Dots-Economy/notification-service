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
});
