/**
 * Case routes (Wave 6, OP:116). Thin zod, then the domain, which owns every rule.
 *
 * Each command is its own POST, as for commitments, so the audit trail and the
 * state table name the action a person took.
 *
 * The remedy amount crosses the wire as a decimal string of paise. A JavaScript
 * number is refused here, before the domain sees it: a number is already rounded
 * by whoever made it, and paise are exact only as a string or a bigint.
 */

import { Router } from 'express';
import { z } from 'zod';
import { SEVERITIES, SENSITIVITY_CLASSES } from '@kaizen/shared';
import {
  CASE_KINDS,
  CASE_STATES,
  acknowledgeCase,
  closeCase,
  getCase,
  listCases,
  openCase,
  raiseExceptionFromCase,
  resolveCase,
  withdrawCase,
} from '../domains/cases.js';
import { wireInt } from '../platform/wire.js';
import { handler, parsePaging, str } from '../lib/http.js';

const router = Router();

export const openCaseBody = z.object({
  kind: z.enum(CASE_KINDS),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  ownerPartyId: z.string().min(1),
  backupPartyId: z.string().min(1).nullable().optional(),
  responseDueAt: z.coerce.date(),
  visibilityTier: z.enum(SENSITIVITY_CLASSES),
  severity: z.enum(SEVERITIES),
  lineId: z.string().min(1).nullable().optional(),
  subjectType: z.string().min(1).nullable().optional(),
  subjectId: z.string().min(1).nullable().optional(),
  remedyAmountMinor: z
    .string()
    .regex(/^\d+$/, 'A remedy amount is a whole number of paise, sent as a string.')
    .nullable()
    .optional()
    .transform((value) => (value === null || value === undefined ? null : BigInt(value))),
});

const reasonBody = z.object({ reason: z.string().trim().max(1000).nullable().optional() });

/** A case on the wire: the paise column as a string, never a number. */
export function caseOnWire<T extends { remedyAmountMinor: bigint | null }>(
  row: T,
): Omit<T, 'remedyAmountMinor'> & { remedyAmountMinor: string | null } {
  return {
    ...row,
    remedyAmountMinor: row.remedyAmountMinor === null ? null : wireInt(row.remedyAmountMinor),
  };
}

router.get(
  '/',
  handler(async (req) => {
    const state = z.enum(CASE_STATES).optional().parse(str(req.query.state));
    const { page, pageSize } = parsePaging(req);
    const rows = await listCases({ state, ownerPartyId: str(req.query.ownerPartyId), page, pageSize });
    return { items: rows.map(caseOnWire) };
  }),
);

router.post(
  '/',
  handler(async (req) => {
    const body = openCaseBody.parse(req.body);
    return caseOnWire(
      await openCase({
        ...body,
        description: body.description ?? null,
        backupPartyId: body.backupPartyId ?? null,
        lineId: body.lineId ?? null,
        subjectType: body.subjectType ?? null,
        subjectId: body.subjectId ?? null,
      }),
    );
  }),
);

router.get(
  '/:id',
  handler(async (req) => caseOnWire(await getCase(req.params.id))),
);

router.post(
  '/:id/acknowledge',
  handler(async (req) => caseOnWire(await acknowledgeCase(req.params.id))),
);

router.post(
  '/:id/resolve',
  handler(async (req) => {
    const body = reasonBody.parse(req.body ?? {});
    return caseOnWire(await resolveCase(req.params.id, body.reason ?? null));
  }),
);

router.post(
  '/:id/close',
  handler(async (req) => {
    const body = reasonBody.parse(req.body ?? {});
    return caseOnWire(await closeCase(req.params.id, body.reason ?? null));
  }),
);

router.post(
  '/:id/withdraw',
  handler(async (req) => {
    const body = z.object({ reason: z.string().trim().min(1).max(1000) }).parse(req.body);
    return caseOnWire(await withdrawCase(req.params.id, body.reason));
  }),
);

router.post(
  '/:id/raise-exception',
  handler(async (req) => {
    const { case: row, exception } = await raiseExceptionFromCase(req.params.id);
    return {
      case: caseOnWire(row),
      exception: {
        id: exception.id,
        recordCode: exception.recordCode,
        code: exception.code,
        severity: exception.severity,
      },
    };
  }),
);

export default router;
