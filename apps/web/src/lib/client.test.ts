import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, onUnauthorized, setToken } from './api.js';
import { del, endpoints, get, patch, post } from './client.js';

// The typed client sits on api.ts, which talks to the API through fetch only,
// so these tests stub fetch. This is the web suite; the API suite is the one
// that must not mock.

type Handler = (path: string, init?: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const REFRESH = '/api/auth/refresh';

describe('typed client: URL, method and body', () => {
  beforeEach(() => {
    setToken(null);
    onUnauthorized(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setToken(null);
    onUnauthorized(null);
  });

  it('get calls /api plus the path with no method override', async () => {
    const fetchFn = stubFetch(() => json(200, [{ id: 'a' }]));

    await expect(get<{ id: string }[]>('/books/accounts')).resolves.toEqual([{ id: 'a' }]);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('/api/books/accounts');
    expect(init?.method).toBeUndefined();
  });

  it('post sends the method and a JSON body', async () => {
    const fetchFn = stubFetch(() => json(200, { id: 'x' }));

    await post<{ id: string }, { reason: string }>('/books/transactions/t1/reverse', { reason: 'typo' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('/api/books/transactions/t1/reverse');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"reason":"typo"}');
  });

  it('post with an empty object sends "{}", not no body', async () => {
    // Finance.tsx's issue call posts `{}`; a server reading req.body depends on it being present.
    const fetchFn = stubFetch(() => json(200, {}));

    await post('/finance/invoices/i1/issue', {});
    expect(fetchFn.mock.calls[0]![1]?.body).toBe('{}');
  });

  it('post with no body sends no body', async () => {
    const fetchFn = stubFetch(() => json(200, {}));

    await post('/command/what-changed/seen');
    expect(fetchFn.mock.calls[0]![1]?.body).toBeUndefined();
  });

  it('patch sends PATCH with a JSON body', async () => {
    const fetchFn = stubFetch(() => json(200, {}));

    await patch('/books/company-profile', { documentYearFormat: 'FY' });
    const init = fetchFn.mock.calls[0]![1];
    expect(init?.method).toBe('PATCH');
    expect(init?.body).toBe('{"documentYearFormat":"FY"}');
  });

  it('del sends DELETE and resolves an empty 204 to undefined', async () => {
    const fetchFn = stubFetch(() => new Response(null, { status: 204 }));

    await expect(del<void>('/books/categories/c1')).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[0]![1]?.method).toBe('DELETE');
  });

  it('an endpoint builds its path from the id without encoding it, as the call sites did', async () => {
    const fetchFn = stubFetch(() => json(200, {}));

    await endpoints.finance.invoiceDocument('inv_123');
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/finance/invoices/inv_123/document');
  });

  it('an endpoint with no id is a fixed path', async () => {
    const fetchFn = stubFetch(() => json(200, []));

    await endpoints.command.decisions();
    expect(fetchFn.mock.calls[0]![0]).toBe('/api/command/decisions');
  });
});

describe('typed client: failures', () => {
  beforeEach(() => {
    setToken(null);
    onUnauthorized(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setToken(null);
    onUnauthorized(null);
  });

  it('raises ApiClientError with the server code and message on a non-2xx', async () => {
    stubFetch(() =>
      json(422, { error: { code: 'VALIDATION', message: 'amount must be positive', details: { field: 'amount' } } }),
    );

    const err = await get('/finance/payments').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 422, code: 'VALIDATION', message: 'amount must be positive' });
  });

  it('a 500 without a body still raises ApiClientError, not a parse failure', async () => {
    stubFetch(() => new Response('', { status: 500, statusText: 'Internal Server Error' }));

    const err = await get('/books/accounts').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 500, code: 'UNKNOWN' });
  });

  it('calls onUnauthorized on a 401 once the refresh cookie is refused', async () => {
    const listener = vi.fn();
    onUnauthorized(listener);
    setToken('expired-token');
    stubFetch((path) =>
      path === REFRESH
        ? json(401, { error: { code: 'NO_SESSION', message: 'no session' } })
        : json(401, { error: { code: 'UNAUTHORIZED', message: 'token expired' } }),
    );

    const err = await get('/books/accounts').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
