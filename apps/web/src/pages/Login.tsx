import { useId, useState } from 'react';
import { AFFILIATION_LABELS, type EntityOption, type TenantKind } from '@kaizen/shared';
import { useSession } from '../lib/session.js';
import { words } from '../lib/words.js';

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

const KIND_WORDS: Record<TenantKind, string> = {
  holding: 'Holding company',
  subsidiary: 'Subsidiary',
  standalone: 'Company',
};

function roleWords(slugs: string[]): string {
  return slugs
    .map((s) => AFFILIATION_LABELS[s as keyof typeof AFFILIATION_LABELS] ?? words(s))
    .join(', ');
}

export function Login() {
  const { signIn, error, notice, pendingSelection, chooseEntity } = useSession();

  if (pendingSelection) {
    return <EntityPicker entities={pendingSelection.entities} onChoose={chooseEntity} error={error} />;
  }

  return <SignInForm signIn={signIn} error={error} notice={notice} />;
}

function SignInForm({
  signIn,
  error,
  notice,
}: {
  signIn: (email: string, password: string) => Promise<void>;
  error: string | null;
  notice: string | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const emailId = useId();
  const passwordId = useId();

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

          {notice && (
            <p className="mb-3 rounded-md border border-band-watch/40 bg-band-watch/10 px-3 py-2 text-2xs font-medium text-band-watch">
              {notice}
            </p>
          )}

          <form onSubmit={submit} className="space-y-3">
            <div>
              <label htmlFor={emailId} className="label">Email</label>
              <input
                id={emailId}
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                autoComplete="username"
              />
            </div>
            <div>
              <label htmlFor={passwordId} className="label">Password</label>
              <input
                id={passwordId}
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

/**
 * Shown in place of the form once `login()` finds the principal holds more
 * than one entity. `suggested` (the email-domain hint, §3.2 — never the
 * reason an entity is reachable) is listed first with a quiet note; every
 * other entity follows in the order the server returned.
 */
function EntityPicker({
  entities,
  onChoose,
  error,
}: {
  entities: EntityOption[];
  onChoose: (tenantId: string) => Promise<void>;
  error: string | null;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const choose = async (tenantId: string) => {
    setBusy(tenantId);
    try {
      await onChoose(tenantId);
    } catch {
      /* surfaced via session error */
    } finally {
      setBusy(null);
    }
  };

  const ordered = [...entities].sort((a, b) => (b.suggested ? 1 : 0) - (a.suggested ? 1 : 0));

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="card w-full max-w-lg p-6">
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-sm border-2 border-gold bg-gold font-display text-lg font-black text-ink-100">
            K
          </div>
          <div>
            <h1 className="text-xl">Which entity?</h1>
            <p className="text-2xs font-bold uppercase tracking-[0.09em] text-ink-500">
              You hold a relationship with more than one
            </p>
          </div>
        </div>

        <div className="space-y-2">
          {ordered.map((e) => (
            <button
              key={e.tenantId}
              onClick={() => choose(e.tenantId)}
              disabled={busy !== null}
              className="flex w-full flex-col items-start gap-0.5 rounded-md border border-ink-800 bg-ink-950 px-3.5 py-3 text-left transition-shadow hover:shadow-raised disabled:opacity-60"
            >
              <span className="text-sm font-semibold text-ink-100">{e.name}</span>
              <span className="text-2xs text-ink-500">
                {KIND_WORDS[e.kind]} · {roleWords(e.roleSlugs)}
              </span>
              {e.suggested && <span className="mt-0.5 text-2xs italic text-accent-soft">Suggested from your email</span>}
              {busy === e.tenantId && <span className="mt-1 text-2xs text-ink-500">Opening…</span>}
            </button>
          ))}
        </div>

        {error && <p className="mt-3 text-2xs text-band-critical">{error}</p>}
      </div>
    </div>
  );
}
