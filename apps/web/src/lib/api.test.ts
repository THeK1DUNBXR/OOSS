import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, api, getToken, onUnauthorized, restoreSession, setToken } from './api.js';

// The client talks to the API through fetch only, so these tests stub fetch.
// The API suite is the one that must not mock; this is the browser side.

type Handler = (path: string, init?: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const ME = '/api/auth/me';
const REFRESH = '/api/auth/refresh';

describe('restoreSession (the page-load renewal)', () => {
  beforeEach(() => setToken(null));
  afterEach(() => vi.unstubAllGlobals());

  it('is renewed when the server issues a new token from the cookie', async () => {
    stubFetch((path) => (path === REFRESH ? json(200, { token: 'fresh-token' }) : json(404, {})));

    await expect(restoreSession()).resolves.toBe('renewed');
    expect(getToken()).toBe('fresh-token');
  });

  it('is ended only when the server refuses the refresh cookie', async () => {
    stubFetch(() => json(401, { error: { code: 'NO_SESSION', message: 'no session' } }));

    await expect(restoreSession()).resolves.toBe('ended');
  });

  it('is unavailable on a 5xx, not ended, so a server outage does not sign anyone out', async () => {
    stubFetch(() => json(503, { error: { code: 'DB_DOWN', message: 'database unavailable' } }));

    await expect(restoreSession()).resolves.toBe('unavailable');
  });

  it('is unavailable on a dropped connection', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    await expect(restoreSession()).resolves.toBe('unavailable');
  });

  it('is unavailable when a 200 carries a body that is not a token', async () => {
    stubFetch(() => new Response('<html>proxy error</html>', { status: 200 }));

    await expect(restoreSession()).resolves.toBe('unavailable');
  });
});

describe('authorised requests and the 401 handler', () => {
  let unauthorized: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setToken('old-token');
    unauthorized = vi.fn();
    onUnauthorized(unauthorized);
  });

  afterEach(() => {
    onUnauthorized(null);
    setToken(null);
    vi.unstubAllGlobals();
  });

  it('ends the session once when the token and the renewal are both refused', async () => {
    stubFetch(() => json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } }));

    await expect(api.get('/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
  });

  it('keeps the session on a 5xx, and reports the server error', async () => {
    stubFetch(() => json(500, { error: { code: 'INTERNAL', message: 'boom' } }));

    const error = await api.get('/auth/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 500, code: 'INTERNAL' });
    expect(unauthorized).not.toHaveBeenCalled();
    expect(getToken()).toBe('old-token');
  });

  it('keeps the session on a dropped connection', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    const error = await api.get('/auth/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(unauthorized).not.toHaveBeenCalled();
    expect(getToken()).toBe('old-token');
  });

  it('reports a renewal that could not reach the server as unavailable, not as a sign-out', async () => {
    stubFetch((path) => (path === ME ? json(401, {}) : json(503, {})));

    await expect(api.get('/auth/me')).rejects.toMatchObject({
      status: 503,
      code: 'SESSION_RENEWAL_UNAVAILABLE',
    });
    expect(unauthorized).not.toHaveBeenCalled();
    expect(getToken()).toBe('old-token');
  });

  it('retries once with the renewed token when the renewal succeeds', async () => {
    const fetchMock = stubFetch((path, init) => {
      if (path === REFRESH) return json(200, { token: 'new-token' });
      const auth = new Headers(init?.headers).get('Authorization');
      return auth === 'Bearer new-token' ? json(200, { userId: 'u1' }) : json(401, {});
    });

    await expect(api.get('/auth/me')).resolves.toEqual({ userId: 'u1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('does not treat a wrong password at sign-in as an ended session', async () => {
    stubFetch(() => json(401, { error: { code: 'BAD_CREDENTIALS', message: 'wrong password' } }));

    await expect(api.post('/auth/login', { email: 'a@b.c', password: 'nope' })).rejects.toMatchObject({
      status: 401,
    });
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
