import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH, validatePassword } from '@kaizen/shared';
import { useSession } from '../lib/session.js';

/**
 * Shown in place of the whole app while a recovered one-time password is the
 * only thing signed in (lib/session.tsx, `passwordChangeRequired`). The server
 * refuses every other route until this succeeds, so this screen is the only
 * place the employee can go, and sign-out stays here for the same reason.
 *
 * The policy is the server's (lib/auth.ts, `assertPasswordAllowed`). The client
 * runs the same shared `validatePassword` first so that the common mistakes
 * cost no round trip; the server's refusal is still the one that counts, and
 * its wording is what the screen shows when it refuses.
 */
export function ChangePassword() {
  const { changePassword, signOut, user } = useSession();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('The new password and its confirmation do not match.');
      return;
    }
    const check = validatePassword(next, user?.email);
    if (!check.valid) {
      setError(check.reasons.join(' '));
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The password could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="card w-full max-w-sm p-6">
        <h1 className="text-xl">Choose your password</h1>
        <p className="mt-1 text-2xs leading-relaxed text-ink-500">
          Your account was recovered, and the password you were given works once. Set your own password to continue.
        </p>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <div>
            <label htmlFor={currentId} className="label">
              Password you were given
            </label>
            <input
              id={currentId}
              className="input"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              type="password"
              autoComplete="current-password"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor={nextId} className="label">
              New password
            </label>
            <input
              id={nextId}
              className="input"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              type="password"
              autoComplete="new-password"
            />
            <p className="mt-1 text-2xs text-ink-500">At least {PASSWORD_MIN_LENGTH} characters.</p>
          </div>
          <div>
            <label htmlFor={confirmId} className="label">
              Confirm new password
            </label>
            <input
              id={confirmId}
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              type="password"
              autoComplete="new-password"
            />
          </div>
          {error && (
            <p role="alert" className="text-2xs text-band-critical">
              {error}
            </p>
          )}
          <button className="btn-primary w-full py-2" disabled={busy || !current || !next || !confirm}>
            {busy ? 'Saving…' : 'Set password and continue'}
          </button>
        </form>

        <button className="btn-ghost mt-3 w-full py-2" onClick={signOut} disabled={busy}>
          Sign out
        </button>
      </div>
    </div>
  );
}
