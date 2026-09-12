/**
 * Shared presentation primitives.
 *
 * Three rules from the platform, made structural here rather than left to
 * design guidance:
 *   - A number with no drill path is a defect, so `Metric` requires an action
 *     or an explicit reason it has none.
 *   - "Not yet measured" and "withheld" are distinct rendered states, never a
 *     zero and never a silent blank.
 *   - An empty state is informative: an automation class that normally fires
 *     and suddenly does not is a signal, not a neutral void.
 */

import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { SensitivityClass, SeverityCode } from '@kaizen/shared';
import {
  BAND_WORDS,
  NOT_MEASURED,
  SENSITIVITY_WORDS,
  severityWord,
  withheldWord,
} from '../lib/words.js';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = 'p-4',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div className="min-w-0">
            {title && <h2 className="card-title truncate">{title}</h2>}
            {subtitle && <p className="card-sub mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

const BAND_STYLE: Record<string, string> = {
  strong: 'text-band-strong border-band-strong/40 bg-band-strong/10',
  stable: 'text-band-stable border-band-stable/40 bg-band-stable/10',
  watch: 'text-band-watch border-band-watch/40 bg-band-watch/10',
  strained: 'text-band-strained border-band-strained/40 bg-band-strained/10',
  critical: 'text-band-critical border-band-critical/40 bg-band-critical/10',
};

export function BandChip({ band }: { band: string | null }) {
  if (!band) return <span className="chip border-ink-700 bg-ink-850 text-ink-400">{NOT_MEASURED}</span>;
  return (
    <span className={`chip ${BAND_STYLE[band] ?? 'border-ink-700 text-ink-300'}`} title={band}>
      {BAND_WORDS[band] ?? band}
    </span>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  S0_INFO: 'text-ink-300 border-ink-700 bg-ink-850',
  S1_ATTENTION: 'text-band-watch border-band-watch/40 bg-band-watch/10',
  S2_WARNING: 'text-band-strained border-band-strained/40 bg-band-strained/10',
  S3_HIGH_RISK: 'text-band-critical border-band-critical/40 bg-band-critical/10',
  S4_CRITICAL: 'text-white border-band-critical bg-band-critical',
};

export function SeverityChip({ severity }: { severity: SeverityCode | string | null }) {
  if (!severity) return null;
  // The code stays in the tooltip: it is what the audit trail records, and
  // someone doing that job needs to be able to find it.
  return (
    <span className={`chip ${SEVERITY_STYLE[severity] ?? 'border-ink-700 text-ink-300'}`} title={String(severity)}>
      {severityWord(String(severity))}
    </span>
  );
}

const SENSITIVITY_STYLE: Record<string, string> = {
  public: 'border-ink-700 text-ink-400',
  internal: 'border-ink-700 text-ink-300',
  restricted: 'border-band-watch/40 text-band-watch',
  confidential: 'border-band-strained/40 text-band-strained',
  regulated: 'border-band-critical/50 text-band-critical',
};

export function SensitivityChip({ level }: { level: SensitivityClass | string }) {
  return (
    <span className={`chip bg-ink-950/60 ${SENSITIVITY_STYLE[level] ?? 'border-ink-700'}`} title={String(level)}>
      {SENSITIVITY_WORDS[level] ?? level}
    </span>
  );
}

export function StatusChip({ status, tone = 'neutral' }: { status: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent' }) {
  const styles = {
    neutral: 'border-ink-700 bg-ink-850 text-ink-300',
    good: 'border-band-strong/40 bg-band-strong/10 text-band-strong',
    warn: 'border-band-watch/40 bg-band-watch/10 text-band-watch',
    bad: 'border-band-critical/40 bg-band-critical/10 text-band-critical',
    accent: 'border-accent/40 bg-accent/10 text-accent-soft',
  };
  return <span className={`chip ${styles[tone]}`}>{status.replace(/_/g, ' ')}</span>;
}

export function RecordCode({ code, to }: { code: string | null | undefined; to?: string }) {
  if (!code) return <span className="mono">—</span>;
  if (to) {
    return (
      <Link to={to} className="mono text-accent-soft hover:text-accent hover:underline">
        {code}
      </Link>
    );
  }
  return <span className="mono">{code}</span>;
}

/**
 * A metric is one interaction away from doing something about it. `drillTo` is
 * required unless `noActionReason` explains why none exists — a dead number is
 * a defect, not a layout choice.
 */
export function Metric({
  label,
  value,
  sub,
  drillTo,
  noActionReason,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  drillTo?: string;
  noActionReason?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  const toneClass = {
    neutral: 'text-ink-100',
    good: 'text-band-strong',
    warn: 'text-band-watch',
    bad: 'text-band-critical',
  }[tone];

  const body = (
    <div className="rounded-lg border border-ink-800 bg-ink-900 p-4 transition-colors hover:border-ink-700">
      <p className="text-2xs font-medium uppercase tracking-wide text-ink-400">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
      {sub && <p className="mt-1 text-2xs text-ink-400">{sub}</p>}
      {!drillTo && noActionReason && <p className="mt-1 text-2xs italic text-ink-500">{noActionReason}</p>}
    </div>
  );

  return drillTo ? (
    <Link to={drillTo} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/**
 * An empty list is itself informative — never demoted to a neutral void.
 */
export function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-4 py-10 text-center">
      <p className="text-sm text-ink-300">{message}</p>
      {hint && <p className="max-w-md text-2xs text-ink-500">{hint}</p>}
    </div>
  );
}

/**
 * A withheld value is shown with its reason code from the closed set, so a
 * viewer can always ask why an item is missing — the one exception being
 * concealment, where recording the withholding would itself be the leak.
 */
export function Withheld({ reason }: { reason: string }) {
  return (
    <span className="chip border-ink-700 bg-ink-850 text-ink-500" title={reason}>
      🔒 {withheldWord(reason)}
    </span>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-ink-400">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
      {label}…
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  const axes = (error as { axes?: Array<{ axis: string; passed: boolean; reason?: string }> })?.axes;

  return (
    <div className="rounded-lg border border-band-critical/40 bg-band-critical/5 p-4">
      <p className="text-sm font-medium text-band-critical">{message}</p>
      {axes && (
        <div className="mt-3 space-y-1">
          <p className="text-2xs uppercase tracking-wide text-ink-400">Why this was refused</p>
          {axes.map((a) => (
            <div key={a.axis} className="flex items-center gap-2 text-2xs">
              <span className={`w-16 font-mono ${a.passed ? 'text-band-strong' : 'text-band-critical'}`}>{a.axis}</span>
              <span className={a.passed ? 'text-ink-400' : 'text-ink-200'}>{a.reason ?? (a.passed ? 'passed' : 'denied')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink-50">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ key: T; label: string; count?: number }>;
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b border-ink-800">
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
            active === t.key
              ? 'border-accent text-ink-50'
              : 'border-transparent text-ink-400 hover:border-ink-700 hover:text-ink-200'
          }`}
        >
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-2xs text-ink-500">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <dt className="text-2xs uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="text-sm text-ink-200">{children}</dd>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-16">
      <div className={`w-full ${width} rounded-lg border border-ink-700 bg-ink-900 shadow-2xl`}>
        <header className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-50">{title}</h2>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-100" aria-label="Close">
            ✕
          </button>
        </header>
        <div className="max-h-[65vh] overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-ink-800 px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** A small inline sparkline-ish bar for factor contributions. */
export function ContributionBar({ value, max, tone = 'accent' }: { value: number; max: number; tone?: 'accent' | 'warn' | 'bad' }) {
  const pct = max > 0 ? Math.max(0, Math.min((value / max) * 100, 100)) : 0;
  const colour = { accent: 'bg-accent', warn: 'bg-band-watch', bad: 'bg-band-critical' }[tone];
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
      <div className={`h-full rounded-full ${colour}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
