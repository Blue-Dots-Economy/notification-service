import { describe, expect, it } from 'vitest';
import { loadDbConfig } from '../config';

const base = {
  DATABASE_HOST: 'db',
  DATABASE_NAME: 'notification',
  DATABASE_USER: 'notification',
  DATABASE_PASSWORD: 'pw',
};

describe('loadDbConfig', () => {
  it('builds a pool config with defaults', () => {
    const cfg = loadDbConfig(base);
    expect(cfg).toMatchObject({
      host: 'db', port: 5432, database: 'notification',
      user: 'notification', password: 'pw', ssl: false, max: 10,
    });
  });

  it('names every missing variable', () => {
    expect(() => loadDbConfig({ DATABASE_HOST: 'db' })).toThrow(
      'Database not configured: missing DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD',
    );
  });

  it('enables verified TLS for DATABASE_SSL=require', () => {
    const cfg = loadDbConfig({ ...base, DATABASE_SSL: 'require' });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('rejects an unknown DATABASE_SSL value instead of guessing', () => {
    expect(() => loadDbConfig({ ...base, DATABASE_SSL: 'prefer' })).toThrow(
      "DATABASE_SSL must be 'disable' or 'require'",
    );
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadDbConfig({ ...base, DATABASE_PORT: 'abc' })).toThrow('DATABASE_PORT');
  });

  it('bounds database waits by default', () => {
    expect(loadDbConfig(base)).toMatchObject({
      connectionTimeoutMillis: 2000, query_timeout: 5000, statement_timeout: 5000,
    });
  });

  it('applies timeout overrides', () => {
    const cfg = loadDbConfig({ ...base, DATABASE_CONNECT_TIMEOUT_MS: '300', DATABASE_QUERY_TIMEOUT_MS: '700' });
    expect(cfg).toMatchObject({ connectionTimeoutMillis: 300, query_timeout: 700, statement_timeout: 700 });
  });

  it('rejects non-numeric or non-positive timeouts', () => {
    expect(() => loadDbConfig({ ...base, DATABASE_CONNECT_TIMEOUT_MS: 'abc' })).toThrow('DATABASE_CONNECT_TIMEOUT_MS');
    expect(() => loadDbConfig({ ...base, DATABASE_QUERY_TIMEOUT_MS: '0' })).toThrow('DATABASE_QUERY_TIMEOUT_MS');
  });

  it('reads DATABASE_POOL_MAX', () => {
    expect(loadDbConfig({ ...base, DATABASE_POOL_MAX: '4' }).max).toBe(4);
  });

  it('rejects a DATABASE_POOL_MAX below 2 or not an integer', () => {
    expect(() => loadDbConfig({ ...base, DATABASE_POOL_MAX: '1' })).toThrow('DATABASE_POOL_MAX must be at least 2');
    expect(() => loadDbConfig({ ...base, DATABASE_POOL_MAX: 'abc' })).toThrow('DATABASE_POOL_MAX');
    expect(() => loadDbConfig({ ...base, DATABASE_POOL_MAX: '2.5' })).toThrow('DATABASE_POOL_MAX');
    expect(() => loadDbConfig({ ...base, DATABASE_POOL_MAX: '0' })).toThrow('DATABASE_POOL_MAX');
  });
});
