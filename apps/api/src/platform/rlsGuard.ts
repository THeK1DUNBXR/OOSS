/**
 * Boot check for the application role (FX-51).
 *
 * Row-level security binds the table owner only when it is forced, and it
 * never binds a superuser or a role with BYPASSRLS. If the API came up as
 * either, every policy would be decorative and the database would serve any
 * tenant's rows to any request. So the server refuses to start in that case
 * rather than run with the isolation switched off without anyone noticing.
 */

import type { PrismaClient } from '@prisma/client';

export async function assertAppRoleRestricted(client: Pick<PrismaClient, '$queryRaw'>): Promise<void> {
  const rows = await client.$queryRaw<{ role: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT current_user::text AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  const row = rows[0];
  if (!row) throw new Error('The database role the API connects as could not be read from pg_roles.');
  if (row.rolsuper || row.rolbypassrls) {
    const grants = [row.rolsuper && 'rolsuper', row.rolbypassrls && 'rolbypassrls'].filter(Boolean).join(' and ');
    throw new Error(
      `Refusing to start: database role "${row.role}" has ${grants}, so row-level security does not apply to it. ` +
        'Set DATABASE_URL to the application role, and MIGRATION_DATABASE_URL to the owner.',
    );
  }
}

/**
 * The opposite check, for the client behind `unscopedPrisma`. The cross-tenant
 * jobs read every tenant's rows through it, which only works if its role
 * bypasses RLS. A superuser bypasses RLS too, so it is accepted.
 */
export async function assertUnscopedRoleBypasses(client: Pick<PrismaClient, '$queryRaw'>): Promise<void> {
  const rows = await client.$queryRaw<{ role: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT current_user::text AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  const row = rows[0];
  if (!row) throw new Error('The database role behind the unscoped client could not be read from pg_roles.');
  if (!row.rolsuper && !row.rolbypassrls) {
    throw new Error(
      `Refusing to start: the unscoped client connects as "${row.role}", which has neither rolbypassrls nor rolsuper. ` +
        'The cross-tenant jobs and the audit chain would see no rows. Set UNSCOPED_DATABASE_URL to the owner role.',
    );
  }
}
