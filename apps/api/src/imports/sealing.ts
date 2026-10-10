/**
 * Regulated cells in a staged import.
 *
 * A staged batch holds the file's cells until somebody commits it. The
 * regulated ones (a guardian's phone, a PAN, a blood group) are sealed while
 * they wait, opened only for the commit and for a caller whose ceiling reaches
 * regulated data, and blanked once the commit has written them into the domain.
 *
 * Sealed with `encryptField`, the same marker the domain records use. The
 * commit opens a staged value and hands it to the domain, which seals it once
 * for its own record. Passing the staged value straight through would seal it
 * twice, and the domain would then store a value that reads back as ciphertext.
 */

import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { assertCan } from '../platform/permissions.js';
import { ApiError } from '../platform/errors.js';
import { emit } from '../platform/eventBus.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { encryptField, readRegulated } from '../domains/compliance/privacy.js';
import {
  EVENTS, REGULATED_EXCLUDED_FIELDS, SENSITIVITY_RANK, isEncryptedFieldValue,
  type SensitivityClass,
} from '@kaizen/shared';
import { TEMPLATES, type TemplateSpec } from './templates.js';

registerGovernedEntities('fin', ['import_batch']);

/**
 * What a staged row shows in place of a regulated value for a caller below
 * the regulated ceiling. Full mask, not the last four characters: the tail of
 * a guardian's phone or a PAN is enough to be someone's identifier, and a
 * viewer who only needs to tell two rows apart can read the file itself.
 */
export const MASKED = '••••••';

/**
 * The fields a template marks regulated. Derived from the template definitions
 * rather than copied here, so a column that starts to carry a PAN or a guardian
 * contact is sealed by the same edit that adds it. A hand copy of this list is
 * how a field gets missed.
 */
const REGULATED_TEMPLATE_FIELDS = Object.values(TEMPLATES).flatMap((spec) =>
  spec.columns.filter((c) => c.regulated).map((c) => c.field),
);

/**
 * Bank fields, for files that are not templates. No template carries a bank
 * account yet; the generic importers can see one in a payroll sheet, and the
 * shared list does not name these.
 */
const GENERIC_BANK_FIELDS = ['bankAccountNumber', 'bankAccountName', 'bankIfsc'];

/**
 * Every field name that holds a regulated value in a normalised row: the
 * template-marked fields, the shared classification that projections already
 * exclude, and the bank fields above.
 */
const REGULATED_STAGED_FIELDS = new Set<string>([
  ...REGULATED_EXCLUDED_FIELDS,
  ...REGULATED_TEMPLATE_FIELDS,
  ...GENERIC_BANK_FIELDS,
]);

/**
 * For a file that is not one of the templates, the heading is all there is to
 * go on. Matched on words so "Pan" in a name does not seal it. The templates
 * use their own column definitions, which carry the field name, and so do not
 * come through here.
 */
const REGULATED_HEADING = /\b(pan|aadhaar|aadhar|uan|pf|esi|ifsc|account (no|number)|bank account|guardian|blood group)\b/i;

const isBlankValue = (v: unknown) => v === null || v === undefined || v === '';

/** Whether a raw cell holds a regulated value, judged from its heading. */
export function isRegulatedCell(heading: string, spec: TemplateSpec | undefined): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const column = spec?.columns.find((c) => norm(c.name) === norm(heading));
  if (column) return column.regulated === true || REGULATED_STAGED_FIELDS.has(column.field);
  return REGULATED_HEADING.test(heading);
}

export function isRegulatedField(key: string): boolean {
  return REGULATED_STAGED_FIELDS.has(key);
}

/** Seals the regulated cells of a raw row. Blank cells stay blank: an empty string says nothing about the person. */
export function sealRawCells(raw: Record<string, unknown>, spec: TemplateSpec | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).map(([heading, value]) => [
      heading,
      isRegulatedCell(heading, spec) && !isBlankValue(value) ? encryptField(String(value)) : value,
    ]),
  );
}

/** Seals the regulated fields of a normalised row, which is what the commit reads. */
export function sealNormalised(normalised: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!normalised) return normalised;
  return Object.fromEntries(
    Object.entries(normalised).map(([key, value]) => [
      key,
      REGULATED_STAGED_FIELDS.has(key) && typeof value !== 'object' && !isBlankValue(value)
        ? encryptField(String(value))
        : value,
    ]),
  );
}

/**
 * Opens the regulated fields of a staged normalised row for the commit. The
 * commit hands the result to the domain, which seals it for its own record, so
 * this returns the original value and nothing else.
 */
export function openStagedNormalised(normalised: unknown): Record<string, unknown> | null {
  if (!normalised || typeof normalised !== 'object') return null;
  return Object.fromEntries(
    Object.entries(normalised as Record<string, unknown>).map(([key, value]) => [
      key,
      typeof value === 'string' && isEncryptedFieldValue(value) ? readRegulated(value) : value,
    ]),
  );
}

/**
 * What a caller at this ceiling is shown for one staged object. A regulated
 * value is opened only for a ceiling that reaches regulated data, and masked
 * otherwise. A value still in clear is masked too, which covers rows staged
 * before sealing existed: they are not rewritten, so the read is the only
 * place they can be protected.
 *
 * `counter.opened` counts the values shown in clear, so the caller can audit a
 * read that revealed something and not one that only revealed masks.
 *
 * Not `applyFieldVisibility`: that walks by field name and drops or nulls keys,
 * but a raw row is keyed by the file's own headings, and what a viewer needs
 * here is the masked value in place, not a missing key. The ceiling test is the
 * same rank comparison it makes.
 */
export function viewStagedObject(
  obj: unknown,
  ceiling: SensitivityClass,
  isRegulatedKey: (key: string, value: unknown) => boolean,
  counter: { opened: number },
): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const cleared = SENSITIVITY_RANK[ceiling] >= SENSITIVITY_RANK.regulated;
  return Object.fromEntries(
    Object.entries(obj as Record<string, unknown>).map(([key, value]) => {
      const sealed = typeof value === 'string' && isEncryptedFieldValue(value);
      if (!sealed && !isRegulatedKey(key, value)) return [key, value];
      if (isBlankValue(value)) return [key, value];
      if (!cleared) return [key, MASKED];
      counter.opened += 1;
      return [key, sealed ? readRegulated(value as string) : value];
    }),
  );
}

/**
 * Blanks the staged cells of a committed import. The rows stay, with their
 * status and their errors, because the audit of an import needs to say which
 * rows were skipped and why; what is removed is the file's own contents, which
 * the books no longer need once they hold what those contents said.
 *
 * Order per CLAUDE.md rule 5: permitted, written, audited, emitted.
 */
export async function purgeStagedRaw(id: string): Promise<{ rows: number }> {
  const auth = currentAuth();
  await assertCan({ resource: 'imports', verb: 'edit' });
  const batch = await prisma.importBatch.findFirst({ where: { id, tenantId: auth.tenantId } });
  if (!batch) throw ApiError.notFound('Import');
  if (batch.status !== 'committed') {
    throw ApiError.conflict('Only a committed import has its staged cells purged. This one is not committed yet.');
  }

  const rows = await prisma.importRow.findMany({
    where: { tenantId: auth.tenantId, batchId: id },
    select: { id: true, normalised: true },
  });
  // Keeps every key, nulls the regulated values: a normalised row that loses
  // its keys reads differently from one whose guardian contact is now blank.
  const normalisedUpdates = rows.flatMap((r) => {
    if (!r.normalised || typeof r.normalised !== 'object') return [];
    const n = r.normalised as Record<string, unknown>;
    const hasRegulated = Object.keys(n).some((k) => REGULATED_STAGED_FIELDS.has(k) && !isBlankValue(n[k]));
    if (!hasRegulated) return [];
    const blanked = Object.fromEntries(
      Object.entries(n).map(([k, v]) => [k, REGULATED_STAGED_FIELDS.has(k) ? null : v]),
    );
    return [{ id: r.id, normalised: blanked }];
  });

  await prisma.$transaction([
    prisma.importRow.updateMany({
      where: { tenantId: auth.tenantId, batchId: id },
      data: { raw: {} as never },
    }),
    ...normalisedUpdates.map((u) =>
      prisma.importRow.update({ where: { id: u.id }, data: { normalised: u.normalised as never } }),
    ),
  ]);

  await auditWrite({
    action: 'update',
    subjectType: 'import_batch',
    subjectId: id,
    meta: { rowsPurged: rows.length, fields: ['raw', 'normalised.regulated'] },
  });

  await emit({
    name: EVENTS.IMPORT_PURGED,
    subject: { entityType: 'import_batch', entityId: id },
    newState: { rowsPurged: rows.length },
    impact: { domains: ['fin'] },
  });

  return { rows: rows.length };
}
