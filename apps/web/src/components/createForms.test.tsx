import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../test/axe.js';
import { NewTransaction, NewVendorBill } from './createForms.js';

/**
 * The Books transaction form, driven the way a person drives it: type, choose,
 * press the button. The fetch stub answers the three lists the form reads and
 * records the create, so the test can see both what was refused and what was sent.
 */

const AMOUNT_ERROR = 'Enter an amount in rupees, such as 1250 or 1250.50';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubBooksApi() {
  const answers: Record<string, unknown> = {
    '/api/books/accounts': [{ id: 'acc-1', name: 'HDFC current', accountType: 'bank' }],
    '/api/books/categories': [{ id: 'cat-1', name: 'Software subscriptions', kind: 'expense' }],
    '/api/books/group-entities': [],
    '/api/books/transactions': { id: 'txn-1' },
    '/api/books/vendor-bills': { id: 'bill-1' },
  };
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
    const path = String(input);
    if (path in answers) return json(200, answers[path]);
    return json(404, { error: { code: 'NOT_STUBBED', message: `no stub for ${path}` } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderForm() {
  const onClose = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NewTransaction open onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

/** The create requests the stub received, with their parsed bodies. */
function postsOf(fetchMock: ReturnType<typeof stubBooksApi>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([path, init]) => ({ path: String(path), body: JSON.parse(String(init?.body)) as unknown }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NewTransaction', () => {
  it('shows an invalid amount beside its field, links the message to the field, and sends nothing', async () => {
    const user = userEvent.setup();
    const fetchMock = stubBooksApi();
    renderForm();

    await screen.findByRole('option', { name: /HDFC current/ });
    await user.type(screen.getByRole('textbox', { name: /^Amount/ }), '1250.499');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Account/ }), 'acc-1');
    await user.click(screen.getByRole('button', { name: 'Record it' }));

    const amount = await screen.findByRole('textbox', { name: /^Amount/ });
    expect(await screen.findByText(AMOUNT_ERROR)).toBeInTheDocument();
    expect(amount).toHaveAttribute('aria-invalid', 'true');

    const describedBy = amount.getAttribute('aria-describedby') ?? '';
    const described = describedBy.split(' ').map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described).toContain(AMOUNT_ERROR);

    expect(postsOf(fetchMock)).toEqual([]);
  });

  it('sends the transaction as rupees on the wire, from the values the form parsed', async () => {
    const user = userEvent.setup();
    const fetchMock = stubBooksApi();
    const { onClose } = renderForm();

    await screen.findByRole('option', { name: /HDFC current/ });
    const date = screen.getByLabelText(/^Date/) as HTMLInputElement;
    await user.type(screen.getByRole('textbox', { name: /^Amount/ }), '1,250.50');
    await user.selectOptions(screen.getByRole('combobox', { name: /^Account/ }), 'acc-1');
    await user.selectOptions(screen.getByRole('combobox', { name: /^What for/ }), 'cat-1');
    await user.type(screen.getByLabelText('Who'), 'Acme Traders');
    await user.click(screen.getByRole('button', { name: 'Record it' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(postsOf(fetchMock)).toEqual([
      {
        path: '/api/books/transactions',
        body: {
          txnDate: date.value,
          direction: 'out',
          amount: 1250.5,
          accountId: 'acc-1',
          categoryId: 'cat-1',
          division: null,
          counterparty: 'Acme Traders',
          reference: null,
          note: null,
          intercompanyTenantId: null,
        },
      },
    ]);
  });

  it('has no axe violations with the amount error shown', async () => {
    const user = userEvent.setup();
    stubBooksApi();
    renderForm();

    await screen.findByRole('option', { name: /HDFC current/ });
    await user.type(screen.getByRole('textbox', { name: /^Amount/ }), '12.345');
    await user.click(screen.getByRole('button', { name: 'Record it' }));
    await screen.findByText(AMOUNT_ERROR);

    await expectNoAxeViolations(document.body);
  });
});

function renderVendorBill() {
  const onClose = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <NewVendorBill open onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

/**
 * An optional money field that was never typed is not a recorded zero. The
 * payload must leave the key out, so the API applies its own default; a zero
 * the person typed is still sent as zero.
 */
describe('NewVendorBill optional tax', () => {
  async function fillBill(user: ReturnType<typeof userEvent.setup>, tax: string | null) {
    await user.type(screen.getByRole('textbox', { name: /^Supplier/ }), 'Acme Traders');
    await user.type(screen.getByRole('textbox', { name: /^Amount before tax/ }), '1000');
    if (tax !== null) await user.type(screen.getByRole('textbox', { name: /^Tax/ }), tax);
    await user.click(screen.getByRole('button', { name: 'Record it' }));
  }

  it('omits taxAmount from the payload when tax was left blank', async () => {
    const user = userEvent.setup();
    const fetchMock = stubBooksApi();
    const { onClose } = renderVendorBill();

    await fillBill(user, null);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [post] = postsOf(fetchMock);
    expect(post?.path).toBe('/api/books/vendor-bills');
    expect(post?.body).toHaveProperty('subtotal', 1000);
    expect(post?.body).not.toHaveProperty('taxAmount');
  });

  it('sends taxAmount as 0 when the person typed zero', async () => {
    const user = userEvent.setup();
    const fetchMock = stubBooksApi();
    const { onClose } = renderVendorBill();

    await fillBill(user, '0');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const [post] = postsOf(fetchMock);
    expect(post?.body).toHaveProperty('taxAmount', 0);
  });
});
