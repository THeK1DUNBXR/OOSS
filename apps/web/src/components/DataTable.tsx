/**
 * The one list-of-records table. Hand-written `<table>` blocks drifted apart
 * (unlabelled, unsortable, some with no empty state at all), so every list
 * screen goes through this instead.
 *
 * Sorting here is client-side over the rows the caller already holds. A list
 * too large to hold whole needs server-driven sort and paging, which this does
 * not yet do; the caller fetches the rows it can show.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { EmptyState, ErrorBox, Loading } from './ui.js';

/**
 * What a sort compares. The raw value, never the rendered text: a money cell
 * shows "₹1.2 L" but must sort on the number it came from.
 */
export type SortValue = string | number | boolean | null | undefined;

export type DataTableColumn<T> = {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Presence makes the column sortable. */
  sortValue?: (row: T) => SortValue;
  align?: 'left' | 'right';
  headerClassName?: string;
  cellClassName?: string;
};

export type DataTableSort = { columnId: string; direction: 'asc' | 'desc' };

/**
 * Opens a record from its row. A bare onClick on the `<tr>` is not reachable
 * by keyboard, so activation is a real button in the first column instead.
 * That column's cell content becomes the button's content, so it must not hold
 * a link or button of its own.
 */
export type DataTableRowAction<T> = {
  /** The button's accessible name. Name the record, e.g. "Open journey Welcome series". */
  label: (row: T) => string;
  onActivate: (row: T) => void;
};

export type DataTableProps<T> = {
  /**
   * Read by screen readers as the table's name. Required because a table with
   * no name is announced as "table, 12 rows" with nothing said about what it
   * holds.
   */
  caption: string;
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: ReadonlyArray<T>;
  /**
   * React key. `index` is the row's position in `rows`, for callers whose records have no
   * unique field of their own (budget variance rows carry none). A duplicate key makes React
   * reuse or drop rows.
   */
  rowKey: (row: T, index: number) => string;
  /** Shown when there are no rows. An empty list must say what would fill it. */
  emptyMessage: string;
  emptyHint?: string;
  loading?: boolean;
  error?: unknown;
  defaultSort?: DataTableSort;
  rowAction?: DataTableRowAction<T>;
  className?: string;
};

function isMissing(value: SortValue): value is null | undefined | '' {
  return value === null || value === undefined || value === '';
}

function compareValues(
  a: Exclude<SortValue, null | undefined | ''>,
  b: Exclude<SortValue, null | undefined | ''>,
): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  // numeric: true so "INV-10" sorts after "INV-9", which is how people read record codes.
  return String(a).localeCompare(String(b), 'en-IN', { numeric: true, sensitivity: 'base' });
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  emptyMessage,
  emptyHint,
  loading = false,
  error,
  defaultSort,
  rowAction,
  className = '',
}: DataTableProps<T>) {
  const [sort, setSort] = useState<DataTableSort | undefined>(defaultSort);

  // Each row keeps its index in `rows` so its key does not change when the sort does.
  const sortedRows = useMemo(() => {
    const indexed = rows.map((row, index) => ({ row, index }));
    const active = columns.find((c) => c.id === sort?.columnId);
    if (!sort || !active?.sortValue) return indexed;
    const pick = active.sortValue;
    const sign = sort.direction === 'asc' ? 1 : -1;
    return indexed.sort((x, y) => {
      const a = pick(x.row);
      const b = pick(y.row);
      // Missing values go last whichever way the column runs. Negating the
      // comparison would put them first on a descending sort.
      if (isMissing(a) || isMissing(b)) return Number(isMissing(a)) - Number(isMissing(b));
      return sign * compareValues(a, b);
    });
  }, [rows, columns, sort]);

  if (error !== undefined && error !== null) {
    return <ErrorBox error={error} />;
  }
  if (loading) {
    return <Loading />;
  }
  if (rows.length === 0) {
    return <EmptyState message={emptyMessage} hint={emptyHint} />;
  }

  const toggle = (columnId: string) => {
    setSort((current) => {
      if (current?.columnId !== columnId) return { columnId, direction: 'asc' };
      return { columnId, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    });
  };

  return (
    <div className={`overflow-x-auto ${className}`}>
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const alignClass = column.align === 'right' ? 'text-right' : '';
              const direction = sort?.columnId === column.id ? sort.direction : undefined;
              const isActive = direction !== undefined;
              const ariaSort = !column.sortValue
                ? undefined
                : direction === undefined
                  ? 'none'
                  : direction === 'asc'
                    ? 'ascending'
                    : 'descending';
              const SortIcon = direction === undefined ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={ariaSort}
                  className={`${alignClass} ${column.headerClassName ?? ''}`}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggle(column.id)}
                      className={`inline-flex items-center gap-1 uppercase hover:text-ink-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                        column.align === 'right' ? 'flex-row-reverse' : ''
                      }`}
                    >
                      {column.header}
                      <SortIcon className={`h-3 w-3 ${isActive ? 'text-accent' : 'text-ink-600'}`} aria-hidden />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map(({ row, index }) => (
            <tr key={rowKey(row, index)}>
              {columns.map((column, columnIndex) => {
                const content = column.cell(row);
                return (
                  <td
                    key={column.id}
                    className={`${column.align === 'right' ? 'text-right tabular-nums' : ''} ${column.cellClassName ?? ''}`}
                  >
                    {rowAction && columnIndex === 0 ? (
                      <button
                        type="button"
                        aria-label={rowAction.label(row)}
                        onClick={() => rowAction.onActivate(row)}
                        className="block w-full cursor-pointer text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        {content}
                      </button>
                    ) : (
                      content
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
