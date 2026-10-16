import { describe, expect, it } from 'vitest';
import { migrationPoolConfig } from '../migrate';

const env = {
  DATABASE_HOST: 'db', DATABASE_NAME: 'notification', DATABASE_USER: 'notification', DATABASE_PASSWORD: 'pw',
  DATABASE_QUERY_TIMEOUT_MS: '700',
};

describe('migrationPoolConfig', () => {
  it('drops the statement and query timeouts but keeps the connect timeout', () => {
    const cfg = migrationPoolConfig(env);
    expect(cfg).not.toHaveProperty('statement_timeout');
    expect(cfg).not.toHaveProperty('query_timeout');
    expect(cfg).toMatchObject({ host: 'db', connectionTimeoutMillis: 2000, max: 2 });
  });
});
