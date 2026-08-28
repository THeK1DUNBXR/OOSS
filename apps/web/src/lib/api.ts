/**
 * The API client. Every response is shaped by the server's five-axis filter —
 * the client never re-implements a permission decision, it renders what it is
 * given and shows withheld reason codes where the server named them.
 */

import type { SessionUser } from '@kaizen/shared';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
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
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export async function login(email: string, password: string) {
  const res = await api.post<{ token: string; user: SessionUser }>('/auth/login', { email, password });
  setToken(res.token);
  return res;
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
