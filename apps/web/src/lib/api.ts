/**
 * The API client. Every response is shaped by the server's five-axis filter —
 * the client never re-implements a permission decision, it renders what it is
 * given and shows withheld reason codes where the server named them.
 */

import type { EntitySelectionResponse, SessionUser } from '@kaizen/shared';

const TOKEN_KEY = 'kaizen.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private window */
  }
}

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  candidates?: unknown[];
  axes?: Array<{ axis: string; passed: boolean; reason?: string }>;
}

export class ApiClientError extends Error implements ApiFailure {
  status: number;
  code: string;
  details?: unknown;
  candidates?: unknown[];
  axes?: Array<{ axis: string; passed: boolean; reason?: string }>;

  constructor(failure: ApiFailure) {
    super(failure.message);
    this.status = failure.status;
    this.code = failure.code;
    this.details = failure.details;
    this.candidates = failure.candidates;
    this.axes = failure.axes;
  }
}

/**
 * Called once by `SessionProvider` to learn about a 401 from anywhere but
 * sign-in itself. The client holds no permission logic of its own — this is
 * only "the token this browser was holding no longer works", so the app can
 * return to the sign-in screen with one line rather than a page of error
 * boxes on a surface that shows share certificates.
 */
let unauthorizedListener: (() => void) | null = null;
export function onUnauthorized(listener: (() => void) | null) {
  unauthorizedListener = listener;
}

/** Paths where a 401 is an expected outcome, not an expired session. */
const AUTH_PATHS = new Set(['/auth/login', '/auth/switch-entity']);

async function request<T>(path: string, init?: RequestInit, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;

  if (!res.ok) {
    if (res.status === 401 && !AUTH_PATHS.has(path)) {
      setToken(null);
      unauthorizedListener?.();
    }
    const err = body?.error ?? {};
    throw new ApiClientError({
      status: res.status,
      code: err.code ?? 'UNKNOWN',
      message: err.message ?? res.statusText,
      details: err.details,
      candidates: err.candidates,
      axes: err.axes,
    });
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  /** A `POST` authorised by a token other than the one in storage — the
   *  five-minute selection token the entity picker exchanges before a
   *  session token exists at all. */
  postWithToken: <T>(path: string, body: unknown, token: string) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }, token),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  /**
   * Downloads a file the API generates, and hands it to the browser.
   *
   * Not an `<a href>`, because the endpoint needs the bearer token and an
   * anchor cannot carry one. The bytes are fetched, wrapped in an object URL,
   * and the click is synthesised — which also means a failure surfaces as an
   * error rather than as a downloaded file containing a JSON error message,
   * which is what an unauthenticated anchor would have saved.
   */
  download: async (path: string, fallbackName: string): Promise<void> => {
    const token = getToken();
    const res = await fetch(`/api${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) {
      const text = await res.text();
      const body = text ? JSON.parse(text) : null;
      const err = body?.error ?? {};
      throw new ApiClientError({
        status: res.status,
        code: err.code ?? 'UNKNOWN',
        message: err.message ?? res.statusText,
      });
    }

    // The server names the file; the fallback is only for the case where a
    // proxy has eaten the header.
    const disposition = res.headers.get('content-disposition') ?? '';
    const named = /filename="([^"]+)"/.exec(disposition)?.[1];

    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = named ?? fallbackName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  /**
   * Sends a file as the request body.
   *
   * Not multipart. The browser can post a File object directly, the server
   * reads the bytes with no boundary-encoding layer in between, and the name
   * rides along in a header — which is the only other thing multipart was
   * carrying. `Content-Type` is deliberately overridden to the file's own,
   * because the default JSON header would be a lie about the bytes.
   */
  upload: async <T>(path: string, file: File, headers: Record<string, string> = {}): Promise<T> => {
    const token = getToken();
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeHeader(file.name),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: file,
    });

    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = body?.error ?? {};
      throw new ApiClientError({
        status: res.status,
        code: err.code ?? 'UNKNOWN',
        message: err.message ?? res.statusText,
        details: err.details,
      });
    }
    return body as T;
  },
};

/**
 * A header value has to be Latin-1, and a filename does not have to be. A
 * spreadsheet called `Salaries – Sept.xlsx`, with an en dash, throws when it
 * reaches `fetch` — so the non-Latin-1 characters are replaced rather than
 * allowed to fail the upload of an otherwise perfectly good file.
 */
function encodeHeader(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '_');
}

/** A session, or one of the two half-way states a sign-in can stop at. */
export type MfaRequired = { mfaRequired: true; challengeToken: string };
export type SessionIssued = { token: string; user: SessionUser };
export type LoginOutcome = SessionIssued | MfaRequired | EntitySelectionResponse;

function storeIfSession<T extends SessionIssued | MfaRequired | EntitySelectionResponse>(res: T): T {
  if ('token' in res) setToken(res.token);
  return res;
}

/**
 * A principal with one entity and no second factor gets a token straight
 * back. One with several entities gets the entity list and a short-lived
 * selection token; one whose account has a second factor gets a challenge.
 * No token is stored until a session is actually issued.
 */
export async function login(email: string, password: string): Promise<LoginOutcome> {
  return storeIfSession(await api.post<LoginOutcome>('/auth/login', { email, password }));
}

/** Completes a login that stopped at `{ mfaRequired: true }`. */
export async function verifyMfa(challengeToken: string, code: string) {
  const res = await api.post<SessionIssued>('/auth/mfa/verify', { challengeToken, code });
  setToken(res.token);
  return res;
}

/** Completes the entity picker shown at sign-in, authorised by the
 *  selection token `login()` returned rather than a session token. The
 *  chosen entity's account may itself ask for a second factor. */
export async function chooseEntity(tenantId: string, selectionToken: string): Promise<SessionIssued | MfaRequired> {
  return storeIfSession(await api.postWithToken<SessionIssued | MfaRequired>('/auth/switch-entity', { tenantId }, selectionToken));
}

/** Moves an already-signed-in principal into another entity they hold an
 *  active affiliation in — the in-session counterpart to `chooseEntity`. */
export async function switchEntity(tenantId: string): Promise<SessionIssued | MfaRequired> {
  return storeIfSession(await api.post<SessionIssued | MfaRequired>('/auth/switch-entity', { tenantId }));
}

export async function switchContext(affiliationId: string, stepUpPassword?: string) {
  const res = await api.post<{ token: string; user: SessionUser }>('/auth/switch-context', {
    affiliationId,
    stepUpPassword,
  });
  setToken(res.token);
  return res;
}

export function logout() {
  setToken(null);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * A masked money value arrives as null with a `withheld` entry naming the
 * reason. Rendering an em dash rather than a zero keeps "withheld" and
 * "genuinely zero" distinguishable — a missing value and a withheld value must
 * never be indistinguishable from a wrong value's perspective.
 */
export function money(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : `${currency} `;
  if (abs >= 10_000_000) return `${sign}${symbol}${(abs / 10_000_000).toFixed(2)} Cr`;
  if (abs >= 100_000) return `${sign}${symbol}${(abs / 100_000).toFixed(2)} L`;
  if (abs >= 1000) return `${sign}${symbol}${(abs / 1000).toFixed(1)}K`;
  return `${sign}${symbol}${abs.toFixed(0)}`;
}

export function moneyExact(value: number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
}

export function date(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relative(value: string | null | undefined): string {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date(value);
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return '—';
  return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
