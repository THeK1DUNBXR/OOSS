/**
 * Technology — service desk jobs (docs/plan/cio.md, workstream D).
 *
 * Two detectors, both idempotent:
 *  - The SLA breach detector fires once per clock (response, resolution) per
 *    ticket, recording the clock in `slaBreachNotified` so a second run
 *    raises nothing new (IT-TKT-002).
 *  - The waiting-too-long nudge flags a ticket that has sat in `waiting`
 *    past a threshold, once per ticket per threshold crossing.
 *
 * The exception owner is the assignee when there is one, else the desk
 * owner resolved by looking up the active affiliation carrying the
 * `hr_ops_manager` role — data, never a role-slug branch in this file's own
 * logic (`resolveDeskOwnerPartyId` does the lookup; nothing here compares a
 * slug).
 */

import { EVENTS, IT_DOMAIN, type SeverityCode } from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';
import { raiseException } from '../../platform/exceptions.js';
import { emit } from '../../platform/eventBus.js';
import { resolveDeskOwnerPartyId } from '../../domains/it/servicedesk.js';
import type { JobDefinition, JobResult } from '../scheduler.js';

/** How long a ticket may sit in `waiting` before the desk is nudged. Not a
 * dated table like the SLA policy — this is a housekeeping heuristic, not a
 * target the company has been asked to commit to. */
const WAITING_NUDGE_HOURS = 48;

export async function runServicedeskJob(): Promise<JobResult> {
  const auth = currentAuth();
  const errors: string[] = [];
  const now = new Date();

  const openTickets = await prisma.itTicket.findMany({
    where: { tenantId: auth.tenantId, status: { in: ['new', 'triaged', 'in_progress', 'waiting'] } },
  });

  let notified = 0;
  let skippedIdempotent = 0;

  for (const ticket of openTickets) {
    const already = new Set(ticket.slaBreachNotified);
    const newlyNotified: string[] = [];

    if (ticket.respondDueAt && !ticket.firstRespondedAt && ticket.respondDueAt < now) {
      if (already.has('response')) {
        skippedIdempotent += 1;
      } else {
        try {
          await raiseBreach(ticket, 'response', ticket.respondDueAt);
          newlyNotified.push('response');
          notified += 1;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    if (ticket.resolveDueAt && !ticket.resolvedAt && ticket.resolveDueAt < now) {
      if (already.has('resolution')) {
        skippedIdempotent += 1;
      } else {
        try {
          await raiseBreach(ticket, 'resolution', ticket.resolveDueAt);
          newlyNotified.push('resolution');
          notified += 1;
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    if (newlyNotified.length > 0) {
      await prisma.itTicket.update({
        where: { id: ticket.id },
        data: { slaBreachNotified: [...already, ...newlyNotified] },
      });
    }
  }

  // Waiting-too-long nudge: a ticket sitting in `waiting` past the
  // threshold, one nudge per crossing (idempotent via triggerFingerprint +
  // ladderRung, the same idempotency key the exception engine already
  // keys on — no extra state needed on the row).
  const waitingTickets = await prisma.itTicket.findMany({
    where: { tenantId: auth.tenantId, status: 'waiting', waitingSince: { not: null } },
  });
  let nudged = 0;
  for (const ticket of waitingTickets) {
    const waitingHours = (now.getTime() - ticket.waitingSince!.getTime()) / 3_600_000;
    if (waitingHours < WAITING_NUDGE_HOURS) continue;
    const ownerPartyId = ticket.assigneePartyId ?? (await resolveDeskOwnerPartyId());
    try {
      await raiseException({
        code: 'IT_TICKET_WAITING_TOO_LONG',
        label: `${ticket.recordCode ?? ticket.id} has been waiting over ${WAITING_NUDGE_HOURS}h`,
        severity: 'S1_ATTENTION',
        subjectType: 'it_ticket',
        subjectId: ticket.id,
        subjectLabel: ticket.recordCode,
        domain: IT_DOMAIN,
        detail: `${ticket.subject} has sat in "waiting" since ${ticket.waitingSince!.toISOString()}, longer than the ${WAITING_NUDGE_HOURS}-hour nudge threshold. Check whether it is still genuinely blocked.`,
        ownerPartyId,
        triggerFingerprint: 'it_ticket_waiting_too_long',
        ladderRung: Math.floor(waitingHours / WAITING_NUDGE_HOURS),
      });
      nudged += 1;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { processed: openTickets.length + waitingTickets.length, notified: notified + nudged, skippedIdempotent, errors };
}

async function raiseBreach(
  ticket: { id: string; recordCode: string | null; subject: string; priority: string | null; assigneePartyId: string | null },
  clock: 'response' | 'resolution',
  dueAt: Date,
) {
  const ownerPartyId = ticket.assigneePartyId ?? (await resolveDeskOwnerPartyId());
  const severity: SeverityCode = clock === 'resolution' ? 'S3_HIGH_RISK' : 'S2_WARNING';

  const exception = await raiseException({
    code: clock === 'response' ? 'IT_TICKET_RESPONSE_BREACHED' : 'IT_TICKET_RESOLUTION_BREACHED',
    label: `${ticket.recordCode ?? ticket.id}: ${clock} SLA breached`,
    severity,
    subjectType: 'it_ticket',
    subjectId: ticket.id,
    subjectLabel: ticket.recordCode,
    domain: IT_DOMAIN,
    detail: `${ticket.subject} (${ticket.priority ?? 'no priority'}) missed its ${clock} due time of ${dueAt.toISOString()}.`,
    ownerPartyId,
    slaDueAt: dueAt,
    triggerFingerprint: `it_ticket_sla_${clock}`,
  });

  await emit({
    name: EVENTS.IT_TICKET_SLA_BREACHED,
    subject: { entityType: 'it_ticket', entityId: ticket.id, recordCode: ticket.recordCode },
    newState: { clock, dueAt },
    owner: { partyId: ownerPartyId },
    impact: { domains: [IT_DOMAIN] },
  });

  return exception;
}

export const JOBS: JobDefinition[] = [
  {
    name: 'runServicedeskJob',
    label: 'Service desk: SLA breach detector (response/resolution) and waiting nudge',
    automationClass: 'threshold_response',
    cron: '*/15 * * * *',
    run: runServicedeskJob,
  },
];
