/**
 * Win/Loss Review (CRM-COML-007).
 *
 * Replaces a bare lost_reason dropdown with a structured post-mortem capturing
 * the named competitor, the real decision-maker, and the real lost stage —
 * feeding Company Memory's LESSON distillation.
 *
 * Mandatoriness is an OR, not an AND, computed once at terminal-state entry and
 * frozen: an edit to the live subject's strategic_value afterward never
 * retroactively changes whether the review was mandatory.
 */

import { EVENTS, formatMinor } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { emit } from '../platform/eventBus.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { ApiError } from '../platform/errors.js';
import { minorOf, type DecimalLike } from '../platform/wire.js';
import { findThreshold, missingThreshold } from './thresholds.js';
import { assertCan } from '../platform/permissions.js';
import { raiseException } from '../platform/exceptions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';

// The lesson a completed review feeds into Company Memory. decisions.ts registers
// the same subject, but this module writes it, so it registers it too: an
// unregistered subject makes auditWrite refuse the write.
registerGovernedEntities('gov', ['lesson']);
import { governedWrite } from '../platform/governedWrite.js';

const DEFAULT_VALUE_THRESHOLD = 500_000;
const GRACE_PERIOD_DAYS = 10;

/** The commercial value that makes a review mandatory, in paise. A missing row is a 409, not DEFAULT_VALUE_THRESHOLD. */
export async function valueThresholdMinor(): Promise<bigint> {
  const key = 'win_loss_review.value_threshold';
  const t = await findThreshold(key);
  if (!t || t.valueMinor === null) throw missingThreshold(key);
  return t.valueMinor;
}

/**
 * The OR gate's money leg. A commercial value that is not measured (null) does
 * not make a review mandatory on its own; the strategic leg still can.
 */
export function commercialClearsThreshold(commercial: bigint | null, threshold: bigint): boolean {
  return commercial !== null && commercial >= threshold;
}

/**
 * Creates the review shell at terminal-state entry, freezing the mandatoriness
 * basis. Called from the stage machine, never by a user directly.
 */
export async function ensureWinLossReview(subjectType: 'opportunity' | 'mou', subjectId: string) {
  const auth = currentAuth();

  const existing = await prisma.winLossReview.findFirst({
    where: { tenantId: auth.tenantId, subjectType, subjectId },
  });
  if (existing) return existing;

  const subject =
    subjectType === 'opportunity'
      ? await prisma.opportunity.findFirst({ where: { id: subjectId } })
      : await prisma.mou.findFirst({ where: { id: subjectId } });
  if (!subject) throw ApiError.notFound('Subject');

  const commercialMinor = minorOf(
    subjectType === 'opportunity'
      ? (subject as { expectedValue: DecimalLike | null }).expectedValue
      : (subject as { commercialValue: DecimalLike | null }).commercialValue,
  );
  const commercial = commercialMinor === null ? null : BigInt(commercialMinor);
  const strategicValue = (subject as { strategicValue: string | null }).strategicValue;
  const threshold = await valueThresholdMinor();

  // The OR gate, computed once.
  const byStrategic = strategicValue === 'high';
  const byValue = commercialClearsThreshold(commercial, threshold);
  const mandatory = byStrategic || byValue;
  const basis = mandatory
    ? [byStrategic ? 'strategic_value=high' : null, byValue ? `commercial_value>=${formatMinor(threshold)}` : null]
        .filter(Boolean)
        .join(' OR ')
    : 'not_mandatory';

  const recordCode = await nextRecordCode('WLR');
  const outcome =
    subjectType === 'opportunity' ? ((subject as { outcome: string | null }).outcome ?? 'lost') : 'not_renewed';

  const review = await prisma.winLossReview.create({
    data: {
      tenantId: auth.tenantId,
      recordCode,
      subjectType,
      subjectId,
      subjectLabel: `${(subject as { recordCode: string }).recordCode} — ${(subject as { title: string }).title}`,
      outcome,
      mandatory,
      mandatoryBasis: basis,
      // Frozen at terminal-state entry.
      strategicValueSnapshot: strategicValue,
      commercialValueSnapshot: commercial === null ? undefined : formatMinor(commercial),
      thresholdUsedSnapshot: formatMinor(threshold),
      lostReason: subjectType === 'opportunity' ? (subject as { lostReason: string | null }).lostReason : null,
      dueAt: mandatory ? new Date(Date.now() + GRACE_PERIOD_DAYS * 86_400_000) : null,
    },
  });

  return review;
}

export interface WinLossInput {
  competitorName?: string | null;
  decisionMakerPersonId?: string | null;
  realLostStage?: string | null;
  lostReason?: string | null;
  lostReasonOtherText?: string | null;
  lesson?: string | null;
}

export async function completeWinLossReview(id: string, input: WinLossInput) {
  const auth = currentAuth();
  const review = await prisma.winLossReview.findFirst({ where: { id } });
  if (!review) throw ApiError.notFound('Win/loss review');

  await assertCan({ resource: 'win_loss_reviews', verb: 'edit', record: { ownerPartyId: review.completedById } });

  if (input.lostReason === 'other' && !input.lostReasonOtherText) {
    throw ApiError.unprocessable('Say what the other reason was.');
  }
  if (review.mandatory && !input.lesson) {
    throw ApiError.unprocessable('This review needs a lesson recorded.');
  }

  return governedWrite(async (tx) => {
    const updated = await tx.winLossReview.update({
      where: { id },
      data: {
        competitorName: input.competitorName ?? null,
        decisionMakerPersonId: input.decisionMakerPersonId ?? null,
        realLostStage: input.realLostStage ?? null,
        lostReason: input.lostReason ?? review.lostReason,
        lostReasonOtherText: input.lostReasonOtherText ?? null,
        lesson: input.lesson ?? null,
        completedById: auth.partyId,
        completedAt: new Date(),
      },
    });

    await auditWrite({
      action: 'update',
      subjectType: 'win_loss_review',
      subjectId: id,
      before: { completedAt: review.completedAt },
      after: { outcome: updated.outcome, lostReason: updated.lostReason, completedAt: updated.completedAt },
      tx,
    });

    // Feeds Company Memory's LESSON entity.
    if (input.lesson) {
      const lesson = await tx.lesson.create({
        data: {
          tenantId: auth.tenantId,
          sourceType: 'win_loss_review',
          sourceId: id,
          title: `${updated.outcome === 'won' ? 'Won' : 'Lost'}: ${review.subjectLabel ?? review.subjectId}`,
          body: input.lesson,
          domain: 'crm',
          tags: [updated.outcome, input.lostReason ?? 'n/a', input.competitorName ?? 'no_competitor'].filter(Boolean),
          createdById: auth.partyId,
        },
      });
      await auditWrite({
        action: 'create',
        subjectType: 'lesson',
        subjectId: lesson.id,
        after: { sourceType: 'win_loss_review', sourceId: id },
        tx,
      });
    }

    await emit({
      name: EVENTS.WIN_LOSS_REVIEW_RECORDED,
      subject: { entityType: 'win_loss_review', entityId: id, recordCode: review.recordCode },
      related: [{ relation: 'reviews', entityType: review.subjectType, entityId: review.subjectId }],
      newState: {
        outcome: updated.outcome,
        competitorName: updated.competitorName,
        lostReason: updated.lostReason,
        realLostStage: updated.realLostStage,
      },
      impact: { domains: ['crm', 'mem'] },
      tx,
    });

    return updated;
  });
}

/** A mandatory review past its grace period is an exception, not a quiet omission. */
export async function detectOverdueReviews(): Promise<number> {
  const auth = currentAuth();
  const overdue = await prisma.winLossReview.findMany({
    where: {
      tenantId: auth.tenantId,
      mandatory: true,
      completedAt: null,
      dueAt: { lt: new Date() },
      overdueNotifiedAt: null,
    },
    take: 200,
  });

  for (const review of overdue) {
    const subject =
      review.subjectType === 'opportunity'
        ? await prisma.opportunity.findFirst({ where: { id: review.subjectId } })
        : await prisma.mou.findFirst({ where: { id: review.subjectId } });

    await raiseException({
      code: 'EX-CRM-015',
      label: 'Win/loss review overdue',
      severity: 'S1_ATTENTION',
      subjectType: 'win_loss_review',
      subjectId: review.id,
      subjectLabel: review.subjectLabel,
      detail: `Mandatory under: ${review.mandatoryBasis}. Grace period of ${GRACE_PERIOD_DAYS} days elapsed.`,
      ownerPartyId: (subject as { ownerPartyId?: string | null } | null)?.ownerPartyId ?? null,
      triggerFingerprint: 'win_loss_overdue',
      ladderRung: 1,
    });

    await governedWrite(async (tx) => {
      await tx.winLossReview.update({ where: { id: review.id }, data: { overdueNotifiedAt: new Date() } });
      await auditWrite({
        action: 'update',
        subjectType: 'win_loss_review',
        subjectId: review.id,
        before: { overdueNotifiedAt: null },
        after: { overdueNotifiedAt: 'set' },
        tx,
      });
      await emit({
        name: EVENTS.WIN_LOSS_REVIEW_OVERDUE,
        subject: { entityType: 'win_loss_review', entityId: review.id, recordCode: review.recordCode },
        newState: { dueAt: review.dueAt },
        impact: { domains: ['crm'], severity: 'S1_ATTENTION' },
        tx,
      });
    });
  }

  return overdue.length;
}
