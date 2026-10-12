/**
 * Session and the context switcher.
 *
 * A grant string held by the session is used ONLY to decide what to render.
 * The server re-evaluates every axis at request time regardless — the client
 * never holds a permission decision, it holds a rendering hint.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EntitySelectionResponse, NavNodeView, SessionUser, Verb } from '@kaizen/shared';
import {
  ApiClientError,
  api,
  changePassword as apiChangePassword,
  chooseEntity as apiChooseEntity,
  getToken,
  restoreSession,
  login as apiLogin,
  logout as apiLogout,
  onPasswordChangeRequired,
  onUnauthorized,
  setToken,
  switchContext as apiSwitch,
  switchEntity as apiSwitchEntity,
  verifyMfa as apiVerifyMfa,
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
  /** Set once a sign-in (or an entity choice) gets `{ mfaRequired: true }`
   *  back — the login screen shows the code prompt while this is non-null. */
  mfaChallengeToken: string | null;
  /** True while a recovered one-time password is the only thing that opens the
   *  app: the shell is replaced by the change-password screen until it is
   *  replaced. The token is kept, because the change needs it. */
  passwordChangeRequired: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  chooseEntity: (tenantId: string) => Promise<void>;
  verifyMfa: (code: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
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
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(null);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);

  const loadNav = useCallback(async () => {
    try {
      setNav(await api.get<NavNodeView[]>('/auth/navigation'));
    } catch {
      setNav([]);
    }
  }, []);

  /**
   * Takes a session the server has just issued. A sign-in whose password is a
   * recovered one-time password goes no further than the change screen: nav is
   * not loaded, because every nav call would be refused until the change is made.
   */
  const adopt = useCallback(
    async (issued: SessionUser) => {
      setUser(issued);
      setPasswordChangeRequired(issued.mustChangePassword);
      if (!issued.mustChangePassword) await loadNav();
    },
    [loadNav],
  );

  const refresh = useCallback(async () => {
    // A page load has no token in memory; the refresh cookie is the way back in.
    if (!getToken()) {
      const outcome = await restoreSession();
      if (outcome !== 'renewed') {
        setUser(null);
        // An unreachable server is not a signed-out user: say so rather than
        // presenting the form as if the cookie had been refused.
        if (outcome === 'unavailable') setError('Could not reach the server. Check your connection and reload.');
        setLoading(false);
        return;
      }
    }
    try {
      const me = await api.get<SessionUser>('/auth/me');
      setPasswordChangeRequired(false);
      setUser(me);
      await loadNav();
    } catch (err) {
      // Only a refused token ends the session. A dropped connection or a 5xx on
      // /auth/me clears nothing, so a blip does not sign the user out. A reload of
      // a recovered sign-in is refused with PASSWORD_CHANGE_REQUIRED: the session is
      // still owed a change, so the token stays and the change screen opens.
      if (err instanceof ApiClientError && err.code === 'PASSWORD_CHANGE_REQUIRED') {
        setPasswordChangeRequired(true);
      } else if (!(err instanceof ApiClientError && err.status === 401)) {
        setError('Could not reach the server. Check your connection and reload.');
        setUser(null);
      } else {
        setToken(null);
        setUser(null);
      }
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
      setMfaChallengeToken(null);
      try {
        const res = await apiLogin(email, password);
        if ('entities' in res) {
          // No token exists yet — the picker below decides which entity the
          // session is actually for.
          setPendingSelection(res);
          return;
        }
        if ('mfaRequired' in res) {
          setMfaChallengeToken(res.challengeToken);
          return;
        }
        await adopt(res.user);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
        throw err;
      }
    },
    [adopt],
  );

  /** Completes sign-in once the picker shown for `pendingSelection` names an
   *  entity. The chosen entity's account may still ask for its code. */
  const chooseEntity = useCallback(
    async (tenantId: string) => {
      if (!pendingSelection) throw new Error('No entity selection in progress.');
      setError(null);
      try {
        const res = await apiChooseEntity(tenantId, pendingSelection.selectionToken);
        setPendingSelection(null);
        if ('mfaRequired' in res) {
          setMfaChallengeToken(res.challengeToken);
          return;
        }
        await adopt(res.user);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open that entity');
        throw err;
      }
    },
    [pendingSelection, adopt],
  );

  const verifyMfa = useCallback(
    async (code: string) => {
      if (!mfaChallengeToken) throw new Error('No sign-in is waiting for a code.');
      setError(null);
      try {
        const res = await apiVerifyMfa(mfaChallengeToken, code);
        setMfaChallengeToken(null);
        await adopt(res.user);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That code is not correct.');
        throw err;
      }
    },
    [mfaChallengeToken, adopt],
  );

  /**
   * Replaces the one-time password, then re-reads the session, which the gate
   * now lets through. A refusal (wrong current password, a weak new one) throws
   * the server's message to the screen and leaves the session as it was.
   */
  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await apiChangePassword(currentPassword, newPassword);
      const me = await api.get<SessionUser>('/auth/me');
      setUser(me);
      setPasswordChangeRequired(false);
      await loadNav();
    },
    [loadNav],
  );

  const signOut = useCallback(() => {
    apiLogout();
    setUser(null);
    setNav([]);
    setPendingSelection(null);
    setPasswordChangeRequired(false);
  }, []);

  // A 401 from any endpoint but sign-in itself means the token this browser
  // held no longer works — revoked, expired, or the server restarted with a
  // new secret. One line above the form, not a screen of error boxes.
  useEffect(() => {
    onUnauthorized(() => {
      setUser(null);
      setNav([]);
      setPendingSelection(null);
      setPasswordChangeRequired(false);
      setNotice('Your session ended. Sign in again.');
    });
    return () => onUnauthorized(null);
  }, []);

  useEffect(() => {
    onPasswordChangeRequired(() => setPasswordChangeRequired(true));
    return () => onPasswordChangeRequired(null);
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
      if ('mfaRequired' in res) {
        // The chosen entity's account has a second factor: the current session
        // is dropped and the code prompt takes over, exactly as at sign-in.
        setToken(null);
        setUser(null);
        setNav([]);
        setMfaChallengeToken(res.challengeToken);
        return;
      }
      await adopt(res.user);
    },
    [adopt],
  );

  const can = useCallback(
    (grant: string) => {
      if (!user) return false;
      const [resource, rest] = grant.split(':');
      const verbToken = (rest ?? 'V').split('@')[0];
      const wanted: Verb =
        verbToken === 'approve' || verbToken === 'merge' ? (verbToken as Verb) : (VERB_LETTERS[verbToken[0]] ?? 'view');

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
      mfaChallengeToken,
      passwordChangeRequired,
      signIn,
      chooseEntity,
      verifyMfa,
      changePassword,
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
      mfaChallengeToken,
      passwordChangeRequired,
      signIn,
      chooseEntity,
      verifyMfa,
      changePassword,
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
