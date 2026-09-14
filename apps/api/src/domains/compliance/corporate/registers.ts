/**
 * Statutory registers — members, directors, charges, KMP, related-party
 * contracts (Companies Act 2013). Append-only: a change to an entry is a new
 * row referencing the one it supersedes, never an edit — the same discipline
 * every filing/document in this platform already keeps.
 */

import type { RegisterKind } from '@kaizen/shared';
import { prisma } from '../../../platform/db.js';
import { currentAuth } from '../../../platform/context.js';
import { ApiError } from '../../../platform/errors.js';
import { assertCan } from '../../../platform/permissions.js';
import { auditWrite } from '../../../platform/audit.js';
import { nextCorporateCode } from './codes.js';

export interface RegisterEntryInput {
  registerKind: RegisterKind;
  subjectKey: string;
  body: Record<string, unknown>;
  supersedesId?: string | null;
}

export async function listRegisterEntries(registerKind?: RegisterKind, subjectKey?: string) {
  await assertCan({ resource: 'corporate_registers', verb: 'view' });
  const auth = currentAuth();
  return prisma.registerEntry.findMany({
    where: {
      tenantId: auth.tenantId,
      ...(registerKind ? { registerKind } : {}),
      ...(subjectKey ? { subjectKey } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Every entry is a create. `supersedesId`, when given, must point at the
 * current head of that subject's chain — a supersede of anything else would
 * silently fork the history rather than continue it.
 */
export async function createRegisterEntry(input: RegisterEntryInput) {
  await assertCan({ resource: 'corporate_registers', verb: 'create' });
  const auth = currentAuth();

  if (input.supersedesId) {
    const prior = await prisma.registerEntry.findFirst({ where: { id: input.supersedesId, tenantId: auth.tenantId } });
    if (!prior) throw ApiError.notFound('Register entry');
    const head = await prisma.registerEntry.findFirst({
      where: { tenantId: auth.tenantId, registerKind: prior.registerKind, subjectKey: prior.subjectKey },
      orderBy: { createdAt: 'desc' },
    });
    if (head?.id !== input.supersedesId) {
      throw ApiError.unprocessable('This entry is not the current head of its subject\'s chain. Supersede the latest entry, not an earlier one — that keeps the register a straight line.');
    }
  }

  const recordCode = await nextCorporateCode('REG');
  const entry = await prisma.registerEntry.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      registerKind: input.registerKind,
      subjectKey: input.subjectKey,
      body: input.body as never,
      supersedesId: input.supersedesId ?? null,
      createdById: auth.partyId,
    },
  });

  await auditWrite({ action: 'create', subjectType: 'register_entry', subjectId: entry.id, after: { recordCode, registerKind: input.registerKind, subjectKey: input.subjectKey } });
  return entry;
}

/** The register as it stands today: the current (unsuperseded) head of every subject in a kind. */
export async function currentRegister(registerKind: RegisterKind) {
  await assertCan({ resource: 'corporate_registers', verb: 'view' });
  const auth = currentAuth();
  const all = await prisma.registerEntry.findMany({
    where: { tenantId: auth.tenantId, registerKind },
    orderBy: { createdAt: 'asc' },
  });

  const superseded = new Set(all.map((e) => e.supersedesId).filter((id): id is string => Boolean(id)));
  return all.filter((e) => !superseded.has(e.id));
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportRegisterCsv(registerKind: RegisterKind): Promise<string> {
  await assertCan({ resource: 'corporate_registers', verb: 'export' });
  const entries = await currentRegister(registerKind);

  const bodyKeys = new Set<string>();
  for (const e of entries) {
    for (const k of Object.keys(e.body as Record<string, unknown>)) bodyKeys.add(k);
  }
  const columns = ['recordCode', 'subjectKey', 'createdAt', ...bodyKeys];
  const rows = entries.map((e) => {
    const body = e.body as Record<string, unknown>;
    return [e.recordCode, e.subjectKey, e.createdAt.toISOString(), ...[...bodyKeys].map((k) => body[k])];
  });

  return [columns.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
}
