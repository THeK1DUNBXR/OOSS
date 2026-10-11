/**
 * The refresh secret travels only in this cookie. It is httpOnly, so page
 * script cannot read it, and it is scoped to /api/auth, so it is sent to the
 * refresh and logout routes and nowhere else.
 *
 * SameSite=Strict is the CSRF defence for the two routes that act on the
 * cookie. Both are POST, and a cross-site request never carries a Strict
 * cookie, so a page on another origin cannot make the browser refresh or end
 * a session on the user's behalf. The web app and API share an origin behind
 * Caddy, so Strict costs nothing for the app itself.
 */

import type { Request, Response } from 'express';
import { config } from '../platform/config.js';

export const REFRESH_COOKIE = 'kz_refresh';
const COOKIE_PATH = '/api/auth';

export function readRefreshCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === REFRESH_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** Secure is required in production; it is off elsewhere so local http development still works. */
function attributes(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: COOKIE_PATH,
    maxAge: maxAgeMs,
  };
}

/** Lasts as long as the session does, so the browser forgets the secret when the session would have ended anyway. */
export function setRefreshCookie(res: Response, value: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, value, attributes(Math.max(0, expiresAt.getTime() - Date.now())));
}

export function clearRefreshCookie(res: Response): void {
  res.cookie(REFRESH_COOKIE, '', attributes(0));
}
