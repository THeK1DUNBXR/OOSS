import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from './components/DataTable.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Shell } from './components/Shell.js';
import { BandChip, Metric, Withheld } from './components/ui.js';
import { Login } from './pages/Login.js';
import { SessionProvider } from './lib/session.js';
import { expectNoAxeViolations } from './test/axe.js';
import { stubSessionApi } from './test/fakeApi.js';

const future = { v7_startTransition: true, v7_relativeSplatPath: true };

/**
 * Page-level rules (document title, html lang, one main landmark) only apply to
 * the whole document, so pages are checked against documentElement. The lang
 * and title mirror apps/web/index.html, which is what the browser sees.
 */
function setDocumentBasics() {
  document.documentElement.lang = 'en';
  document.title = 'KaiERP';
}

// restoreAllMocks is deliberately not used: it would also undo the canvas stub
// in setup.ts for every test after the first.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('accessibility (axe-core)', () => {
  describe('components', () => {
    it('Metric, with a drill link and with a stated reason', async () => {
      render(
        <MemoryRouter future={future}>
          <main>
            <Metric label="Open invoices" value={3} drillTo="/finance/invoices" />
            <Metric label="Attendance" value={12} noActionReason="Computed from today's snapshot" />
            <Metric label="Hidden" value={<Withheld reason="no_permission" />} noActionReason="Access is checked" />
            <Metric label="Unmeasured" value={<BandChip band={null} />} noActionReason="No snapshot yet" />
          </main>
        </MemoryRouter>,
      );

      await expectNoAxeViolations(document.body);
    });

    it('DataTable with sortable columns and a row action', async () => {
      type Invoice = { code: string; amount: number | null };
      const columns: DataTableColumn<Invoice>[] = [
        { id: 'code', header: 'Invoice', cell: (r) => r.code, sortValue: (r) => r.code },
        {
          id: 'amount',
          header: 'Amount',
          align: 'right',
          cell: (r) => (r.amount === null ? '—' : String(r.amount)),
          sortValue: (r) => r.amount,
        },
      ];
      render(
        <main>
          <DataTable<Invoice>
            caption="Invoices for March"
            columns={columns}
            rows={[
              { code: 'INV-9', amount: 50 },
              { code: 'INV-10', amount: null },
            ]}
            rowKey={(r) => r.code}
            emptyMessage="No invoices yet"
            rowAction={{ label: (r) => `Open invoice ${r.code}`, onActivate: () => {} }}
          />
        </main>,
      );

      await expectNoAxeViolations(document.body);
    });

    it('DataTable empty state', async () => {
      render(
        <main>
          <DataTable<{ id: string }>
            caption="Leads"
            columns={[{ id: 'id', header: 'Lead', cell: (r) => r.id }]}
            rows={[]}
            rowKey={(r) => r.id}
            emptyMessage="No leads yet"
            emptyHint="Leads appear when a form is submitted"
          />
        </main>,
      );

      await expectNoAxeViolations(document.body);
    });

    it('ErrorBoundary fallback for a screen and for the whole app', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const Broken = () => {
        throw new Error('render exploded');
      };
      // A route-scope fallback sits inside the shell's <main>, so the test puts it there too.
      const { unmount } = render(
        <MemoryRouter future={future}>
          <main>
            <ErrorBoundary scope="route">
              <Broken />
            </ErrorBoundary>
          </main>
        </MemoryRouter>,
      );
      await expectNoAxeViolations(document.body);
      unmount();

      render(
        <ErrorBoundary scope="app">
          <Broken />
        </ErrorBoundary>,
      );
      await expectNoAxeViolations(document.body);
      consoleError.mockRestore();
    });
  });

  describe('pages', () => {
    beforeEach(() => setDocumentBasics());

    it('sign-in page', async () => {
      stubSessionApi({ signedIn: false });
      render(
        <MemoryRouter future={future}>
          <SessionProvider>
            <Login />
          </SessionProvider>
        </MemoryRouter>,
      );
      await screen.findByLabelText('Email');

      await expectNoAxeViolations(document.documentElement);
    });

    it('second-factor page, reached by a sign-in that asks for a code', async () => {
      stubSessionApi({ signedIn: false, loginResponse: { mfaRequired: true, challengeToken: 'challenge-1' } });
      const user = userEvent.setup();
      render(
        <MemoryRouter future={future}>
          <SessionProvider>
            <Login />
          </SessionProvider>
        </MemoryRouter>,
      );
      await user.type(await screen.findByLabelText('Email'), 'asha@example.test');
      await user.type(screen.getByLabelText('Password'), 'correct horse');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      await screen.findByRole('heading', { name: 'Enter your code' });

      await expectNoAxeViolations(document.documentElement);
    });

    it('signed-in app shell and its navigation', async () => {
      stubSessionApi({ signedIn: true });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/workspace']} future={future}>
            <SessionProvider>
              <Routes>
                <Route element={<Shell />}>
                  <Route path="/workspace" element={<h1>Workspace</h1>} />
                </Route>
              </Routes>
            </SessionProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await screen.findByRole('navigation');
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeInTheDocument());

      await expectNoAxeViolations(document.documentElement);
    });
  });
});
