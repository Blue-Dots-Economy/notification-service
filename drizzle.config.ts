import { defineConfig } from 'drizzle-kit';

const required = ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(`drizzle-kit needs ${missing.join(', ')}`);
}

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    host: process.env.DATABASE_HOST!,
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: process.env.DATABASE_NAME!,
    user: process.env.DATABASE_USER!,
    password: process.env.DATABASE_PASSWORD!,
    ssl: process.env.DATABASE_SSL === 'require',
  },
  strict: true,
  verbose: true,
});
