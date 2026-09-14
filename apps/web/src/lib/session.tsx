/**
 * Session and the context switcher.
 *
 * A grant string held by the session is used ONLY to decide what to render.
 * The server re-evaluates every axis at request time regardless — the client
 * never holds a permission decision, it holds a rendering hint.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EntitySelectionResponse, NavNodeView, SessionUser, Verb } from '@kaizen/shared';
import { loginNeedsEntitySelection } from '@kaizen/shared';
import {
  api,
  chooseEntity as apiChooseEntity,
  getToken,
  login as apiLogin,
  logout as apiLogout,
  onUnauthorized,
  setToken,
  switchContext as apiSwitch,
  switchEntity as apiSwitchEntity,
} from './api.js';

interface SessionState {
  user: SessionUser | null;
  nav: NavNodeView[];
  loading: boolean;
  error: string | null;
  /** A one-line notice for the sign-in screen — currently only "your session
   *  ended", surfaced by the global 401 handler rather than an error box. */
  notice: string | null;
  /** Set by `signIn` when the principal holds more than one entity: the
   *  picker renders in place of the form until `chooseEntity` resolves it. */
  pendingSelection: EntitySelectionResponse | null;
  signIn: (email: string, password: string) => Promise<void>;
  chooseEntity: (tenantId: string) => Promise<void>;
  signOut: () => void;
  switchTo: (affiliationId: string, stepUpPassword?: string) => Promise<void>;
  switchEntity: (tenantId: string) => Promise<void>;
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
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSelection, setPendingSelection] = useState<EntitySelectionResponse | null>(null);

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
      setNotice(null);
      try {
        const res = await apiLogin(email, password);
        if (loginNeedsEntitySelection(res)) {
          // No token exists yet — the picker below decides which entity the
          // session is actually for.
          setPendingSelection(res);
          return;
        }
        setUser(res.user);
        await loadNav();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
        throw err;
      }
    },
    [loadNav],
  );

  /** Completes sign-in once the picker shown for `pendingSelection` names an
   *  entity. */
  const chooseEntity = useCallback(
    async (tenantId: string) => {
      if (!pendingSelection) throw new Error('No entity selection in progress.');
      setError(null);
      try {
        const res = await apiChooseEntity(tenantId, pendingSelection.selectionToken);
        setUser(res.user);
        setPendingSelection(null);
        await loadNav();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open that entity');
        throw err;
      }
    },
    [pendingSelection, loadNav],
  );

  const signOut = useCallback(() => {
    apiLogout();
    setUser(null);
    setNav([]);
    setPendingSelection(null);
  }, []);

  // A 401 from any endpoint but sign-in itself means the token this browser
  // held no longer works — revoked, expired, or the server restarted with a
  // new secret. One line above the form, not a screen of error boxes.
  useEffect(() => {
    onUnauthorized(() => {
      setUser(null);
      setNav([]);
      setPendingSelection(null);
      setNotice('Your session ended. Sign in again.');
    });
    return () => onUnauthorized(null);
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

  /**
   * Moves an already-signed-in principal into another entity, entirely
   * separate from `switchTo` (which stays within one entity's affiliations).
   * Reach never unions across entities either — the new session is composed
   * fresh, exactly as `switchTo` composes fresh across affiliations.
   */
  const switchEntity = useCallback(
    async (tenantId: string) => {
      const res = await apiSwitchEntity(tenantId);
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
    () => ({
      user,
      nav,
      loading,
      error,
      notice,
      pendingSelection,
      signIn,
      chooseEntity,
      signOut,
      switchTo,
      switchEntity,
      can,
      refresh,
    }),
    [
      user,
      nav,
      loading,
      error,
      notice,
      pendingSelection,
      signIn,
      chooseEntity,
      signOut,
      switchTo,
      switchEntity,
      can,
      refresh,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside a SessionProvider');
  return ctx;
}
