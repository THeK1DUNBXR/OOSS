import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from './DataTable.js';

type Invoice = { code: string; amount: number | null; status: string };

const invoices: Invoice[] = [
  { code: 'INV-10', amount: 300, status: 'paid' },
  { code: 'INV-9', amount: 50, status: 'open' },
  { code: 'INV-2', amount: null, status: 'open' },
];

const columns: DataTableColumn<Invoice>[] = [
  { id: 'code', header: 'Invoice', cell: (r) => r.code, sortValue: (r) => r.code },
  {
    id: 'amount',
    header: 'Amount',
    align: 'right',
    cell: (r) => (r.amount === null ? '—' : String(r.amount)),
    sortValue: (r) => r.amount,
  },
  { id: 'status', header: 'Status', cell: (r) => r.status },
];

function bodyCodes(): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[0].textContent ?? '');
}

function renderTable(overrides: Partial<React.ComponentProps<typeof DataTable<Invoice>>> = {}) {
  return render(
    <DataTable<Invoice>
      caption="Invoices for March"
      columns={columns}
      rows={invoices}
      rowKey={(r) => r.code}
      emptyMessage="No invoices yet"
      {...overrides}
    />,
  );
}

describe('DataTable', () => {
  it('is named by its caption', () => {
    renderTable();

    expect(screen.getByRole('table', { name: 'Invoices for March' })).toBeInTheDocument();
  });

  it('marks only sortable columns with aria-sort, and starts them unsorted', () => {
    renderTable();

    expect(screen.getByRole('columnheader', { name: 'Invoice' })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: 'Amount' })).toHaveAttribute('aria-sort', 'none');
    expect(screen.getByRole('columnheader', { name: 'Status' })).not.toHaveAttribute('aria-sort');
  });

  it('toggles aria-sort and row order between ascending and descending', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Invoice' }));
    expect(screen.getByRole('columnheader', { name: 'Invoice' })).toHaveAttribute('aria-sort', 'ascending');
    // Natural order, so INV-9 comes before INV-10 as people read record codes.
    expect(bodyCodes()).toEqual(['INV-2', 'INV-9', 'INV-10']);

    await user.click(screen.getByRole('button', { name: 'Invoice' }));
    expect(screen.getByRole('columnheader', { name: 'Invoice' })).toHaveAttribute('aria-sort', 'descending');
    expect(bodyCodes()).toEqual(['INV-10', 'INV-9', 'INV-2']);
  });

  it('keeps rows with no value last whichever way the column runs', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole('button', { name: 'Amount' }));
    expect(bodyCodes()).toEqual(['INV-9', 'INV-10', 'INV-2']);

    await user.click(screen.getByRole('button', { name: 'Amount' }));
    expect(bodyCodes()).toEqual(['INV-10', 'INV-9', 'INV-2']);
  });

  it('opens a record from a real button in the first column when a row action is given', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    renderTable({
      rowAction: { label: (r) => `Open invoice ${r.code}`, onActivate },
    });

    const open = screen.getByRole('button', { name: 'Open invoice INV-9' });
    await user.click(open);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(invoices[1]);
  });

  it('shows the empty message, and no table, when there are no rows', () => {
    renderTable({ rows: [], emptyHint: 'Invoices appear once a sale is posted' });

    expect(screen.getByText('No invoices yet')).toBeInTheDocument();
    expect(screen.getByText('Invoices appear once a sale is posted')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the error instead of the rows when the load failed', () => {
    renderTable({ error: new Error('Invoices could not be loaded') });

    expect(screen.getByText('Invoices could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a loading state, not the empty message, while rows are loading', () => {
    renderTable({ rows: [], loading: true });

    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(screen.queryByText('No invoices yet')).toBeNull();
  });
});
