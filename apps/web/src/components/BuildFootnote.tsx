/**
 * The footnote at the bottom of every screen: what is running, and against what.
 *
 * It exists because of a class of hour-long confusion that no screen reveals.
 * The code is right and the thing in front of you is not: a browser holding a
 * bundle from before the fix, or a tenant whose seeded rows — the grant matrix,
 * the navigation and its vocabulary — were never re-seeded, so the sidebar goes
 * on answering with words that were replaced two deploys ago. Neither looks like
 * anything. Both look like the change not working.
 *
 * So three sequences, side by side, because the three go stale independently:
 *
 *     web 148 · api 148 · data #12 (seeded at build 148)
 *
 * A sequence is the count of commits behind a build, and it is the number a
 * person can compare without thinking — 148 is plainly later than 147, where
 * `7ab59ff` and `035870e` are two strings. The commit is there for looking one
 * up, quietly, in the title attribute.
 *
 * When they disagree it says so in words rather than leaving somebody to notice
 * two numbers differ.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';

interface Stamp {
  sequence: number;
  commit: string;
  builtAt: string | null;
  known: boolean;
}

interface VersionReport {
  api: Stamp & { version: string; label: string; startedAt: string };
  seed: {
    sequence: number;
    at: string | null;
    build: number | null;
    commit: string | null;
    navNodes: number | null;
  } | null;
  seedBehindBy: number;
  expected: { navNodes: number };
  grants: { pending: number; changed: number; revoked: number };
}

/** Baked in by Vite at build time. See `vite.config.ts`. */
declare const __BUILD__: Stamp;
const WEB: Stamp =
  typeof __BUILD__ === 'undefined' ? { sequence: 0, commit: '', builtAt: null, known: false } : __BUILD__;

const when = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'unknown';

export function BuildFootnote() {
  const { data } = useQuery({
    queryKey: ['version'],
    queryFn: () => api.get<VersionReport>('/meta/version'),
    // It changes on a deploy, not on a click. Long and quiet.
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const apiStamp = data?.api;
  const seed = data?.seed;

  // The two comparisons worth making, stated rather than implied.
  const bundleStale =
    WEB.known && apiStamp?.known && WEB.sequence > 0 && apiStamp.sequence > 0 && WEB.sequence !== apiStamp.sequence;
  const seedStale = (data?.seedBehindBy ?? 0) > 0;
  const neverSeeded = Boolean(data) && !seed;
  // Boot fills in resources nobody had a row for; changing or revoking an
  // existing grant stays deliberate, so what is left here is waiting on
  // somebody. A missing permission shows up as a button that is not there,
  // which is the least diagnosable symptom in the product.
  const grantsPending = data?.grants?.pending ?? 0;

  const parts = [
    `web ${WEB.known ? WEB.sequence || WEB.commit : '—'}`,
    `api ${apiStamp ? (apiStamp.sequence || apiStamp.commit || '—') : '…'}`,
    seed ? `data #${seed.sequence}` : neverSeeded ? 'data never seeded' : 'data …',
  ];

  return (
    <footer className="mt-8 border-t border-ink-850 px-1 pb-2 pt-3 text-2xs text-ink-600">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="mono"
          title={[
            `web bundle: ${WEB.commit || 'unknown'}${WEB.builtAt ? `, built ${when(WEB.builtAt)}` : ''}`,
            apiStamp
              ? `api: ${apiStamp.version} ${apiStamp.commit || 'unknown'}, started ${when(apiStamp.startedAt)}`
              : 'api: not reached',
            seed
              ? `data: seeded ${when(seed.at)} from build ${seed.build ?? '—'} (${seed.commit || 'unknown'}), ${seed.navNodes ?? '—'} nav rows`
              : 'data: no seed recorded',
          ].join('\n')}
        >
          {parts.join(' · ')}
        </span>

        {/* Said in words. Two numbers differing is only obvious to whoever
            already suspects it, and the point is the person who does not. */}
        {bundleStale && (
          <span className="text-band-critical">
            — this page is build {WEB.sequence}, the server is {apiStamp!.sequence}. Reload.
          </span>
        )}
        {seedStale && (
          <span className="text-band-watch">
            — set-up data is {data!.seedBehindBy} build{data!.seedBehindBy === 1 ? '' : 's'} behind. Run{' '}
            <span className="mono">pnpm db:seed</span>.
          </span>
        )}
        {neverSeeded && (
          <span className="text-band-watch">— this company has never been set up. Run pnpm db:seed.</span>
        )}
        {grantsPending > 0 && (
          <span className="text-band-watch">
            — {grantsPending} permission change{grantsPending === 1 ? '' : 's'} waiting. Run{' '}
            <span className="mono">pnpm grants:reconcile --apply</span>.
          </span>
        )}
      </p>
    </footer>
  );
}
