/**
 * Compliance — labour. Rate tables and other structure the tenant needs
 * before use. Safe to re-run.
 */
import { prisma } from '../../platform/db.js';
import { currentAuth } from '../../platform/context.js';

/**
 * The three fixed national holidays for the current calendar year, plus a
 * note that state holidays are declared by notification through the year
 * rather than fixed in advance. Seeded for the year the tenant is created in
 * — a tenant carried into a new year re-seeds by adding that year's rows
 * through the Holidays screen, not by this running again.
 */
async function seedHolidays() {
  const tenantId = currentAuth().tenantId;
  const year = new Date().getUTCFullYear();
  const national = [
    { date: new Date(Date.UTC(year, 0, 26)), name: 'Republic Day' },
    { date: new Date(Date.UTC(year, 7, 15)), name: 'Independence Day' },
    { date: new Date(Date.UTC(year, 9, 2)), name: 'Gandhi Jayanti' },
  ];
  let created = 0;
  for (const h of national) {
    const existing = await prisma.holiday.findFirst({ where: { tenantId, date: h.date, name: h.name } });
    if (existing) continue;
    await prisma.holiday.create({ data: { tenantId, date: h.date, name: h.name, kind: 'national' } });
    created += 1;
  }

  const noteName = 'State holidays declared by notification';
  const existingNote = await prisma.holiday.findFirst({ where: { tenantId, name: noteName, kind: 'restricted' } });
  if (!existingNote) {
    await prisma.holiday.create({
      data: {
        tenantId,
        date: new Date(Date.UTC(year, 0, 1)),
        name: noteName,
        kind: 'restricted',
        state: 'TN',
        note:
          'Tamil Nadu state and restricted holidays (Pongal, festival days) are announced by government ' +
          'notification through the year and are not fixed in advance — add each as it is notified.',
      },
    });
    created += 1;
  }
  console.log(`  ${created} labour holidays (${national.length} national + 1 notification note)`);
}

/**
 * TN Shops & Establishments Act defaults: 8-hour day, 48-hour week, 12-hour
 * spread-over, overtime at 2x, a 50-hour-per-quarter overtime cap.
 * `confirmed: false` — this is the plan's own reading of the Act, not
 * checked against the live state notification.
 */
async function seedWorkingHoursRule() {
  const tenantId = currentAuth().tenantId;
  const existing = await prisma.workingHoursRule.findFirst({ where: { tenantId } });
  if (existing) return;
  await prisma.workingHoursRule.create({
    data: {
      tenantId,
      effectiveFrom: new Date(Date.UTC(2020, 3, 1)),
      dailyCapHours: 8,
      weeklyCapHours: 48,
      spreadOverHours: 12,
      otMultiplier: 2,
      otCapPerQuarterHours: 50,
      confirmed: false,
      note: 'Tamil Nadu Shops and Establishments Act reading — confirm against the live state notification.',
    },
  });
  console.log('  1 working-hours rule (TN S&E Act defaults, unconfirmed)');
}

/**
 * Paternity leave. Not statutory under central law (unlike maternity leave),
 * so `statutory: false` — a company policy this platform records rather than
 * a legal entitlement it enforces.
 */
async function seedPaternityLeaveType() {
  const tenantId = currentAuth().tenantId;
  const existing = await prisma.leaveType.findFirst({ where: { tenantId, code: 'PL' } });
  if (existing) return;
  await prisma.leaveType.create({
    data: {
      tenantId,
      code: 'PL',
      name: 'Paternity Leave',
      annualEntitlementDays: 7,
      statutory: false,
      employmentStateAffecting: false,
    },
  });
  console.log('  1 leave type (PL — paternity leave, company policy, not a central statutory entitlement)');
}

export async function seedLabour(): Promise<void> {
  await seedHolidays();
  await seedWorkingHoursRule();
  await seedPaternityLeaveType();
}
