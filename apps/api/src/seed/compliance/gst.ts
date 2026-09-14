import { currentAuth } from '../../platform/context.js';
import { prisma } from '../../platform/db.js';

/**
 * Compliance — gst. Rate tables and other structure the tenant needs before
 * use. Safe to re-run.
 *
 * Late fee (Sec 47) and interest (Sec 50) as notified today: ₹25/day CGST +
 * ₹25/day SGST (₹50/day total) for a non-nil return, capped at ₹5,000; 18%
 * per annum interest on the net cash tax liability. GSTR-1 due the 11th of
 * the following month, GSTR-3B the 20th — the company's own registration's
 * dates, changed here if a notification changes them, never in code.
 */
export async function seedGst(): Promise<void> {
  const auth = currentAuth();

  const existing = await prisma.gstRateTable.findFirst({ where: { tenantId: auth.tenantId } });
  if (!existing) {
    await prisma.gstRateTable.create({
      data: {
        tenantId: auth.tenantId,
        effectiveFrom: new Date('2021-01-01T00:00:00.000Z'),
        lateFeePerDayCgst: 25,
        lateFeePerDaySgst: 25,
        cap: 5000,
        interestPct: 18,
        gstr1DueDay: 11,
        gstr3bDueDay: 20,
      },
    });
  }
}
