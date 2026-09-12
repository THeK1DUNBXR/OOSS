import { useState } from 'react';
import { useSession } from '../lib/session.js';

/**
 * Four roles, described rather than offered as demo logins.
 *
 * This panel used to list ten accounts you could click to sign in as, which is
 * the right thing for a demonstration and the wrong thing for a company's own
 * sign-in page: it published a working password beside ten real addresses. What
 * survives is the part that was actually useful — an explanation of why the
 * same screen shows different things to different people.
 */
const ROLES = [
  { label: 'Employee', note: 'Their own leave, attendance and payslips, the staff directory, and the invoices they raise.' },
  { label: 'Operations Head', note: 'People, delivery and the course catalogue. Proposes pay but cannot approve it.' },
  { label: 'Finance Head', note: 'The books, GST returns, and approving pay and payroll.' },
  { label: 'Chairman', note: 'Everything.' },
];

export function Login() {
  const { signIn, error } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await signIn(email, password);
    } catch {
      /* surfaced via session error */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="grid w-full max-w-4xl gap-6 lg:grid-cols-2">
        <div className="card p-6">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-sm border-2 border-gold bg-gold font-display text-lg font-black text-ink-100">
              K
            </div>
            <div>
              <h1 className="text-xl">KaiERP</h1>
              <p className="text-2xs font-bold uppercase tracking-[0.09em] text-ink-500">
                ERP Platform of Kaizen Infinities
              </p>
            </div>
          </div>

          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="label">Email</label>
              <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                autoComplete="current-password"
              />
            </div>
            {error && <p className="text-2xs text-band-critical">{error}</p>}
            <button className="btn-primary w-full py-2" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-4 text-2xs leading-relaxed text-ink-500">
            What you can see comes from your job, not your account.
          </p>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-ink-100">What you see depends on what you do here</h2>
          <p className="mt-1 text-2xs leading-relaxed text-ink-500">
            Four roles. Each sees what their job needs.
          </p>

          <div className="mt-4 space-y-1.5">
            {ROLES.map((r) => (
              <div key={r.label} className="rounded-md border border-ink-800 bg-ink-950 px-3 py-2">
                <span className="text-xs font-medium text-ink-100">{r.label}</span>
                <p className="mt-0.5 text-2xs leading-snug text-ink-500">{r.note}</p>
              </div>
            ))}
          </div>

          <p className="mt-4 text-2xs leading-relaxed text-ink-500">
            Your account is created for you. Ask them to reset it if you cannot get in.
          </p>
        </div>
      </div>
    </div>
  );
}
