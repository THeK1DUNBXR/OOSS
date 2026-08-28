import { useState } from 'react';
import { useSession } from '../lib/session.js';

const DEMO_ACCOUNTS = [
  { email: 'chairman@kaizen.co.in', label: 'Chairman', note: 'Command Center archetype — the full pulse, decision queue and authority controls.' },
  { email: 'bhead@kaizen.co.in', label: 'Business Head', note: 'First approval tier. Interim catalog and territory owner.' },
  { email: 'controller@kaizen.co.in', label: 'Finance Controller', note: 'Holds the discount-approval authority the blocked quote resolves to.' },
  { email: 'arun@kaizen.co.in', label: 'Sales', note: 'A real but modest authority ceiling, so an over-ceiling deal opens a step.' },
  { email: 'divya@kaizen.co.in', label: 'Telecaller', note: 'Own-scoped mutation. View and export still resolve to all.' },
  { email: 'meera@kaizen.co.in', label: 'Education Counsellor', note: 'own_or_unowned on institutions, with the branch check only in the unowned case.' },
  { email: 'ravi@kaizen.co.in', label: 'Trainer', note: 'Scoped to own batches by a grant resolver, not by a role check in service code.' },
  { email: 'sysadmin@kaizen.co.in', label: 'System Administrator', note: 'Platform administration with explicitly no domain content authority.' },
  { email: 'multi@kaizen.co.in', label: 'Three affiliations', note: 'Try the context switcher — reach never unions across contexts.' },
];

export function Login() {
  const { signIn, error } = useSession();
  const [email, setEmail] = useState('chairman@kaizen.co.in');
  const [password, setPassword] = useState('kaizen2026');
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
            <div className="flex h-9 w-9 items-center justify-center rounded bg-accent text-base font-bold text-white">K</div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-ink-50">Kaizen</h1>
              <p className="text-2xs text-ink-500">Unified Operating Platform</p>
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
            Access derives from affiliations, never from the person record. An account holding no active affiliation
            cannot sign in, however valid its credential.
          </p>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-ink-100">Sign in as any role</h2>
          <p className="mt-1 text-2xs text-ink-500">
            Every account uses the password <span className="font-mono text-ink-300">kaizen2026</span>. The surface
            recomposes against the role's own grants — a node you cannot reach is unrendered, never merely disabled.
          </p>

          <div className="mt-4 space-y-1.5">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                onClick={() => {
                  setEmail(a.email);
                  setPassword('kaizen2026');
                }}
                className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                  email === a.email ? 'border-accent bg-accent/10' : 'border-ink-800 bg-ink-950 hover:border-ink-600'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium text-ink-100">{a.label}</span>
                  <span className="mono">{a.email.split('@')[0]}</span>
                </div>
                <p className="mt-0.5 text-2xs leading-snug text-ink-500">{a.note}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
