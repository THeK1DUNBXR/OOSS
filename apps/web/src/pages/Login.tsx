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
  {
    label: 'Employee',
    note: 'Their own leave, attendance, payslip and skills, plus the staff directory — and they raise invoices for what they sell, seeing the ones they raised and no others.',
  },
  {
    label: 'Operations Head',
    note: 'The people function end to end, delivery, education and the course catalogue. Proposes pay and cannot approve it.',
  },
  {
    label: 'Finance Head',
    note: 'The books and the GST returns, and the money side of people: approves pay and payroll, and sees what the establishment costs without running it.',
  },
  {
    label: 'Chairman',
    note: 'Everything. Every screen, every record, every action — nothing in the system is hidden from this one.',
  },
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
            What you can see comes from your job here, not from your account. Someone who has left keeps their
            record but loses their access — the password alone is never enough.
          </p>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-ink-100">What you see depends on what you do here</h2>
          <p className="mt-1 text-2xs leading-relaxed text-ink-500">
            There are four roles, and the same screen shows different things to each. Menus you hold no grant on are
            absent rather than greyed out, because a link you can never enable is not information.
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
            Your account is created for you by whoever set the company up. If you cannot get in, they can reset it —
            there is no self-service password here on purpose, because an ERP account is an employment fact.
          </p>
        </div>
      </div>
    </div>
  );
}
