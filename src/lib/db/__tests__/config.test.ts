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
});
