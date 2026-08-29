import { useState } from 'react';
import { useSession } from '../lib/session.js';

const DEMO_ACCOUNTS = [
  { email: 'chairman@kaizen.co.in', label: 'Chairman', note: 'Sees the whole company, and makes the calls nobody else can.' },
  { email: 'bhead@kaizen.co.in', label: 'Business Head', note: 'Approves deals up to ₹10 lakh. Above that it goes to a director.' },
  { email: 'controller@kaizen.co.in', label: 'Finance Controller', note: 'The only one who can sign off a discount bigger than a salesperson is allowed to give.' },
  { email: 'arun@kaizen.co.in', label: 'Salesperson', note: 'Runs his own deals. Big ones need someone senior to approve.' },
  { email: 'divya@kaizen.co.in', label: 'Telecaller', note: 'Can see every lead, but only change the ones assigned to her.' },
  { email: 'meera@kaizen.co.in', label: 'Education Counsellor', note: 'Can claim any college in her branch that nobody else has taken.' },
  { email: 'ravi@kaizen.co.in', label: 'Trainer', note: 'Sees the batches he teaches, and no others.' },
  { email: 'latha@kaizen.co.in', label: 'Finance', note: 'Records payments — which even the chairman cannot do.' },
  { email: 'sysadmin@kaizen.co.in', label: 'System Administrator', note: 'Runs the system, and cannot read a single customer record.' },
  { email: 'multi@kaizen.co.in', label: 'Someone with three jobs', note: 'Switch between them in the sidebar — what he sees changes with the hat he is wearing.' },
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
            What you can see comes from your job here, not from your account. Someone who has left keeps their
            record but loses their access — the password alone is never enough.
          </p>
        </div>

        <div className="card p-6">
          <h2 className="text-sm font-semibold text-ink-100">Have a look as somebody else</h2>
          <p className="mt-1 text-2xs text-ink-500">
            Every account below uses the password <span className="font-mono text-ink-300">kaizen2026</span>. Sign in
            as any of them and the whole app changes — menus you have no business seeing simply are not there, rather
            than sitting greyed out. Try the system administrator and the finance clerk one after the other.
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
