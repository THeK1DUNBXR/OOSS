/**
 * Tally's XML export.
 *
 * The other half of the Tally story. Its Excel reports are what an accountant
 * hands you; its XML is what the software itself emits, from Gateway → Display
 * → Day Book → Export, and from the ODBC/HTTP interface. The XML carries the
 * ledger entries as structured amounts rather than as formatted strings, so
 * where it is available it is the better source.
 *
 * The shape, reduced to what matters:
 *
 *   <ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
 *     <TALLYMESSAGE>
 *       <VOUCHER VCHTYPE="Payment" ACTION="Create">
 *         <DATE>20260819</DATE>
 *         <VOUCHERNUMBER>173</VOUCHERNUMBER>
 *         <NARRATION>Facebook ads</NARRATION>
 *         <ALLLEDGERENTRIES.LIST>
 *           <LEDGERNAME>Advertisements - Social Media</LEDGERNAME>
 *           <AMOUNT>2478.00</AMOUNT>
 *         </ALLLEDGERENTRIES.LIST>
 *         ...
 *
 * Tally's sign convention is the thing to get right: a NEGATIVE amount is a
 * debit and a positive one is a credit. It reads backwards to anybody who has
 * not met it before, and getting it wrong inverts the entire ledger while
 * still balancing perfectly — which is exactly the kind of wrong that survives
 * review.
 */

import { XMLParser } from 'fast-xml-parser';
import { toAmount, toDate } from './parse.js';
import type { Extraction, StagedRow } from './extract.js';
import { createHash } from 'node:crypto';

const digest = (...parts: unknown[]): string =>
  createHash('sha256').update(parts.map((p) => String(p ?? '')).join(' ')).digest('hex').slice(0, 32);

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v)).trim();

/** Tally writes YYYYMMDD; older exports write `19-Aug-2026`. */
function tallyDate(value: unknown): Date | null {
  const s = text(value);
  if (/^\d{8}$/.test(s)) {
    return new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))));
  }
  return toDate(s, true);
}

export function extractTallyXml(xml: string): Extraction {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    parseTagValue: false,
    trimValues: true,
    // Tally exports are not always well-formed by a strict reader's standards:
    // narrations carry raw ampersands and control characters. Tolerating that
    // is the difference between importing somebody's books and telling them
    // their accounting software produces invalid XML.
    processEntities: false,
  });

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    return {
      rows: [],
      notes: [`The file could not be read as XML: ${(error as Error).message}`],
      columns: [],
    };
  }

  const vouchers = collectVouchers(doc);
  const rows: StagedRow[] = [];
  const notes: string[] = [];

  vouchers.forEach((voucher, index) => {
    const date = tallyDate(voucher.DATE ?? voucher.EFFECTIVEDATE);
    const voucherNo = text(voucher.VOUCHERNUMBER);
    const voucherType = text(voucher['@VCHTYPE'] ?? voucher.VOUCHERTYPENAME);
    const narration = text(voucher.NARRATION);
    const party = text(voucher.PARTYLEDGERNAME);

    const entries = [
      ...asArray(voucher['ALLLEDGERENTRIES.LIST'] as Record<string, unknown>[]),
      ...asArray(voucher['LEDGERENTRIES.LIST'] as Record<string, unknown>[]),
    ];

    if (!date || entries.length === 0) {
      rows.push({
        rowNumber: index + 1,
        raw: { voucherNo, voucherType, narration },
        normalised: null,
        status: 'skipped',
        message: !date ? 'The voucher has no readable date.' : 'The voucher has no ledger entries.',
      });
      return;
    }

    for (const entry of entries) {
      const ledger = text(entry.LEDGERNAME);
      const raw = toAmount(text(entry.AMOUNT));
      if (!ledger || raw === null || raw === 0) continue;

      // Negative is a debit. See the note at the top — this one line is the
      // whole of Tally's sign convention.
      const side = raw < 0 ? 'debit' : 'credit';

      rows.push({
        rowNumber: index + 1,
        raw: { voucherNo, voucherType, ledger, amount: text(entry.AMOUNT), narration, party },
        normalised: {
          ledger,
          contraAccount: party || null,
          txnDate: date.toISOString(),
          amount: Math.abs(raw),
          side,
          voucherType,
          voucherNo,
          narration: narration || `${voucherType} ${voucherNo}`.trim(),
        },
        status: 'ready',
        dedupeKey: digest('tally', voucherType, voucherNo, date.toISOString().slice(0, 10), Math.abs(raw)),
      });
    }
  });

  notes.push(`${vouchers.length} vouchers.`);
  return { rows, notes, columns: ['voucherNo', 'voucherType', 'ledger', 'amount', 'narration'] };
}

/**
 * Finds the vouchers wherever this particular export put them.
 *
 * Tally's envelope varies by version and by which report produced it —
 * IMPORTDATA/REQUESTDATA for a Day Book, DATA/TALLYMESSAGE for a masters
 * export — so the tree is walked for VOUCHER nodes rather than indexed by a
 * path that is right for one export and wrong for the next.
 */
function collectVouchers(node: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 12 || node == null || typeof node !== 'object') return [];

  const out: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.toUpperCase() === 'VOUCHER') {
      out.push(...(asArray(value) as Record<string, unknown>[]));
      continue;
    }
    for (const child of asArray(value as unknown) as unknown[]) {
      out.push(...collectVouchers(child, depth + 1));
    }
  }
  return out;
}

export function looksLikeTallyXml(xml: string): boolean {
  const head = xml.slice(0, 8000).toUpperCase();
  return head.includes('<ENVELOPE') || head.includes('<TALLYMESSAGE') || head.includes('<VOUCHER');
}
