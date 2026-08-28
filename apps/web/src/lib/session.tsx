/**
 * Session and the context switcher.
 *
 * A grant string held by the session is used ONLY to decide what to render.
 * The server re-evaluates every axis at request time regardless — the client
 * never holds a permission decision, it holds a rendering hint.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { NavNodeView, SessionUser, Verb } from '@kaizen/shared';
import { api, getToken, login as apiLogin, logout as apiLogout, setToken, switchContext as apiSwitch } from './api.js';

interface SessionState {
  user: SessionUser | null;
  nav: NavNodeView[];
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  switchTo: (affiliationId: string, stepUpPassword?: string) => Promise<void>;
  can: (grant: string) => boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

const VERB_LETTERS: Record<string, Verb> = {
  V: 'view',
  C: 'create',
  E: 'edit',
  D: 'delete',
  A: 'assign',
  X: 'export',
  F: 'financial',
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [nav, setNav] = useState<NavNodeView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadNav = useCallback(async () => {
    try {
      setNav(await api.get<NavNodeView[]>('/auth/navigation'));
    } catch {
      setNav([]);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get<SessionUser>('/auth/me');
      setUser(me);
      await loadNav();
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [loadNav]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null);
      try {
        const res = await apiLogin(email, password);
        setUser(res.user);
        await loadNav();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
        throw err;
      }
    },
    [loadNav],
  );

  const signOut = useCallback(() => {
    apiLogout();
    setUser(null);
    setNav([]);
  }, []);

  /**
   * Switching re-composes the screen against the new affiliation's grants
   * alone. Reach never unions across contexts.
   */
  const switchTo = useCallback(
    async (affiliationId: string, stepUpPassword?: string) => {
      const res = await apiSwitch(affiliationId, stepUpPassword);
      setUser(res.user);
      await loadNav();
    },
    [loadNav],
  );

  const can = useCallback(
    (grant: string) => {
      if (!user) return false;
      const [resource, rest] = grant.split(':');
      const verbToken = (rest ?? 'V').split('@')[0];
      const wanted: Verb =
        verbToken === 'approve' || verbToken === 'merge'
          ? (verbToken as Verb)
          : (VERB_LETTERS[verbToken[0]] ?? 'view');

      return user.grants.some((g) => {
        const [gRes, gRest] = g.split(':');
        if (gRes !== resource) return false;
        const gVerbs = (gRest ?? '').split('@')[0];
        if (wanted === 'approve' || wanted === 'merge') return gVerbs.includes(wanted);
        const letter = Object.entries(VERB_LETTERS).find(([, v]) => v === wanted)?.[0];
        return letter ? gVerbs.includes(letter) : false;
      });
    },
    [user],
  );

  const value = useMemo<SessionState>(
    () => ({ user, nav, loading, error, signIn, signOut, switchTo, can, refresh }),
    [user, nav, loading, error, signIn, signOut, switchTo, can, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside a SessionProvider');
  return ctx;
}
