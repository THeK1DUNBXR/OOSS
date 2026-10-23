import { describe, expect, it } from 'vitest';
import type { InvoiceView } from '@kaizen/shared';
import { invoicesShown } from './Finance.js';

// Only the fields invoicesShown reads are set. The rest of InvoiceView is
// irrelevant to which tab an invoice sits in or whether a search matches it.
function invoice(p: Partial<InvoiceView> & { id: string }): InvoiceView {
  return {
    label: `INV/${p.id}`,
    customerName: 'Customer',
    division: null,
    status: 'issued',
    outstanding: 0,
    lines: [],
    ...p,
  } as InvoiceView;
}

const ids = (rows: InvoiceView[]) => rows.map((r) => r.id);

const rows: InvoiceView[] = [
  invoice({ id: 'draft', status: 'draft', outstanding: 500 }),
  invoice({ id: 'owed', status: 'issued', outstanding: 500 }),
  invoice({ id: 'paid', status: 'settled', outstanding: 0 }),
  invoice({ id: 'void', status: 'void', outstanding: 0 }),
  invoice({
    id: 'course-paid',
    division: 'education',
    status: 'settled',
    outstanding: 0,
    customerName: 'Priya Rao',
    lines: [{ courseName: 'Data Science Foundations' } as InvoiceView['lines'][number]],
  }),
  invoice({
    id: 'course-void',
    division: 'education',
    status: 'void',
    outstanding: 0,
    customerName: 'Arjun Mehta',
    lines: [{ courseName: 'Tally Prime' } as InvoiceView['lines'][number]],
  }),
  invoice({ id: 'course-owed', division: 'education', status: 'issued', outstanding: 900 }),
];

describe('invoicesShown tabs', () => {
  it('owed tab is outstanding, issued and not void', () => {
    expect(ids(invoicesShown(rows, 'open', ''))).toEqual(['owed', 'course-owed']);
  });

  it('drafts tab is draft status only', () => {
    expect(ids(invoicesShown(rows, 'drafts', ''))).toEqual(['draft']);
  });

  it('everything tab returns every row', () => {
    expect(ids(invoicesShown(rows, 'all', ''))).toEqual(ids(rows));
  });

  it('course sales tab is every education invoice, paid and void included', () => {
    expect(ids(invoicesShown(rows, 'courses', ''))).toEqual(['course-paid', 'course-void', 'course-owed']);
  });

  it('a generic invoice never appears on the course sales tab', () => {
    expect(invoicesShown(rows, 'courses', '').every((i) => i.division === 'education')).toBe(true);
  });
});

describe('invoicesShown search', () => {
  it('matches the invoice number, ignoring case and surrounding space', () => {
    expect(ids(invoicesShown(rows, 'all', '  INV/PAID '))).toEqual(['paid']);
  });

  it('matches the customer name', () => {
    expect(ids(invoicesShown(rows, 'all', 'priya'))).toEqual(['course-paid']);
  });

  it('matches the course name on the first line that has one', () => {
    expect(ids(invoicesShown(rows, 'all', 'DATA SCIENCE'))).toEqual(['course-paid']);
  });

  it('searches inside the current tab only', () => {
    expect(invoicesShown(rows, 'drafts', 'owed')).toEqual([]);
    expect(ids(invoicesShown(rows, 'courses', 'arjun'))).toEqual(['course-void']);
  });

  it('a blank query is the whole tab', () => {
    expect(ids(invoicesShown(rows, 'open', '   '))).toEqual(['owed', 'course-owed']);
  });
});
