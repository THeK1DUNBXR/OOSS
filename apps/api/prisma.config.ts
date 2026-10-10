import { defineConfig } from 'prisma/config';

// A prisma.config.ts turns off Prisma's own .env loading, so developers who keep
// DATABASE_URL in apps/api/.env would lose it. Load the file here instead;
// process.loadEnvFile does not overwrite variables already set in the shell, and
// a missing .env is fine (CI and the test scripts pass DATABASE_URL directly).
try {
  process.loadEnvFile('.env');
} catch {
  // no .env file
}

// Prisma reads a folder-based schema's migrations from `prisma/schema/migrations`
// unless told otherwise. The migration history lives beside the schema's parent
// (`prisma/migrations`) so it stays where the baseline and drift tooling expect
// it. The `package.json#prisma` key is deprecated and goes away in Prisma 7, so
// the paths live here.
export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
  },
});
