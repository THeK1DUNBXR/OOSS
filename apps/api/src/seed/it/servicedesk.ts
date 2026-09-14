/**
 * Technology — service desk seed (docs/plan/cio.md, workstream D).
 *
 * The SLA policy table: a starting point, not a decision the company has
 * made (docs/plan/cio.md, "Open questions for Kaizen Infinities" — the
 * seeded P1 30m/4h .. P4 1d/10d table is explicitly called out as one). The
 * web screen repeats that caveat; upserted idempotently so re-running the
 * seed against a tenant that already has these rows only updates them in
 * place rather than versioning a new row each time.
 */

import { unscopedPrisma } from '../../platform/db.js';
import { currentTenantId } from '../../platform/context.js';

interface SlaSeed {
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  responseMinutes: number;
  resolutionMinutes: number;
  note: string;
}

const SLA_POLICIES: SlaSeed[] = [
  { priority: 'P1', responseMinutes: 30, resolutionMinutes: 4 * 60, note: 'Critical — business-stopping. A starting point, not a target the company has committed to.' },
  { priority: 'P2', responseMinutes: 60, resolutionMinutes: 8 * 60, note: 'High. A starting point, not a target the company has committed to.' },
  { priority: 'P3', responseMinutes: 4 * 60, resolutionMinutes: 3 * 24 * 60, note: 'Medium. A starting point, not a target the company has committed to.' },
  { priority: 'P4', responseMinutes: 24 * 60, resolutionMinutes: 10 * 24 * 60, note: 'Low. A starting point, not a target the company has committed to.' },
];

const SEED_EFFECTIVE_FROM = new Date('2024-01-01T00:00:00.000Z');

export async function seedServicedesk(): Promise<void> {
  const tenantId = currentTenantId();

  for (const s of SLA_POLICIES) {
    const existing = await unscopedPrisma.itSlaPolicy.findFirst({
      where: { tenantId, priority: s.priority, effectiveFrom: SEED_EFFECTIVE_FROM },
    });
    if (existing) {
      await unscopedPrisma.itSlaPolicy.update({
        where: { id: existing.id },
        data: {
          responseMinutes: s.responseMinutes,
          resolutionMinutes: s.resolutionMinutes,
          businessHoursOnly: true,
          note: s.note,
        },
      });
    } else {
      await unscopedPrisma.itSlaPolicy.create({
        data: {
          tenantId,
          priority: s.priority,
          responseMinutes: s.responseMinutes,
          resolutionMinutes: s.resolutionMinutes,
          businessHoursOnly: true,
          effectiveFrom: SEED_EFFECTIVE_FROM,
          note: s.note,
        },
      });
    }
  }
}
