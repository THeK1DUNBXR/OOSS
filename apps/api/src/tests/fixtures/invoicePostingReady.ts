/**
 * Makes a tenant able to issue and collect invoices into the journal (Phase 0). A tenant
 * with none of this refuses an issue, and says what is missing (invoicePosting.ts), which
 * is right in production. The demonstration tenant and the suites that make their own
 * tenants need it before their first invoice, so this is the one place it is written.
 *
 * What it provides, each row only when it is missing, so the call can be repeated:
 *   - one ledger entity, if the tenant has none (a tenant with several is left alone:
 *     invoices there name their entity, and this does not choose one);
 *   - a ledger account for every posting role an invoice or a receipt uses, the revenue
 *     and round-off accounts being P&L accounts as a real chart has them;
 *   - a business line for each invoice division, a REVENUE mapping per line, and the
 *     division-to-line map itself;
 *   - a BANK mapping for each payment mode.
 *
 * Real Postgres through unscopedPrisma, no mocks. It writes setup rows, never journal rows.
 */
import { randomUUID } from 'node:crypto';
import { DIVISIONS, PAYMENT_MODES } from '@kaizen/shared';
import { unscopedPrisma } from '../../platform/db.js';

// Earlier than any date a suite backdates an invoice to (the GST suites scan from 1990). A
// mapping that starts later refuses an issue on an earlier day, so the start is well before them.
const FROM = new Date('1900-01-01T00:00:00.000Z');

/** The accounts the invoice and receipt postings resolve, by role and class. */
const TAX_ROLES = [
  { role: 'OUTPUT_CGST', accountClass: 'liability' },
  { role: 'OUTPUT_SGST', accountClass: 'liability' },
  { role: 'OUTPUT_IGST', accountClass: 'liability' },
] as const;

export async function readyInvoicePosting(tenantId: string): Promise<void> {
  // One entity when the tenant has none. A tenant with several is left as it is: its
  // invoices name the entity they are booked to, and choosing one here would hide that.
  const count = await unscopedPrisma.ledgerEntity.count({ where: { tenantId } });
  if (count === 0) {
    await unscopedPrisma.ledgerEntity.create({
      data: { tenantId, code: 'INVPOST', legalName: 'Invoice posting fixture entity', stateCode: '27' },
    });
  }

  const account = async (name: string, accountClass: 'asset' | 'liability' | 'income', requiresParty = false) =>
    (await unscopedPrisma.ledgerAccount.findFirst({ where: { tenantId, name } })) ??
    (await unscopedPrisma.ledgerAccount.create({
      data: { tenantId, name, accountClass, requiresParty },
    }));

  const mapRole = async (role: string, scopeKey: string, ledgerAccountId: string) => {
    // Looked up by its start date, not by any row: a tenant seeded with a later start still
    // needs the earlier one, and posting roles are insert-only, so a new row is the fix.
    const mapped = await unscopedPrisma.ledgerPostingRole.findFirst({
      where: { tenantId, role, scopeKey, effectiveFrom: FROM },
    });
    if (!mapped) {
      await unscopedPrisma.ledgerPostingRole.create({
        data: { tenantId, role, scopeKey, ledgerAccountId, effectiveFrom: FROM, setById: randomUUID() },
      });
    }
  };

  const receivable = await account('INV-POST TEST ONLY TRADE_RECEIVABLE', 'asset', true);
  await mapRole('TRADE_RECEIVABLE', '', receivable.id);

  for (const { role, accountClass } of TAX_ROLES) {
    const taxAccount = await account(`INV-POST TEST ONLY ${role}`, accountClass);
    await mapRole(role, '', taxAccount.id);
  }
  const roundOff = await account('INV-POST TEST ONLY ROUND_OFF', 'income');
  await mapRole('ROUND_OFF', '', roundOff.id);

  for (const mode of PAYMENT_MODES) {
    const bank = await account(`INV-POST TEST ONLY BANK ${mode}`, 'asset');
    await mapRole('BANK', mode, bank.id);
  }

  for (const division of DIVISIONS) {
    const code = `INVPOST-${division.toUpperCase()}`;
    const line =
      (await unscopedPrisma.businessLine.findFirst({ where: { tenantId, code } })) ??
      (await unscopedPrisma.businessLine.create({
        data: {
          tenantId,
          code,
          name: `Invoice posting fixture ${division}`,
          payerKind: 'corporate',
          revenueModel: 'licence',
          effectiveFrom: FROM,
        },
      }));
    const revenue = await account(`INV-POST TEST ONLY REVENUE ${division}`, 'income');
    await mapRole('REVENUE', line.id, revenue.id);

    const starts = await unscopedPrisma.invoiceDivisionLine.findFirst({
      where: { tenantId, division, effectiveFrom: FROM },
    });
    if (!starts) {
      await unscopedPrisma.invoiceDivisionLine.create({
        data: { tenantId, division, lineId: line.id, effectiveFrom: FROM, createdById: randomUUID() },
      });
    }
  }
}
