/**
 * The entity level of the switcher.
 *
 * `switchTo`/`ContextSwitcher` in `Shell.tsx` moves between affiliations
 * inside one entity; this moves between entities themselves — the level the
 * equity-portal plan adds above it (§3.2). One list, `GET /auth/entities`,
 * rendered twice: as a level inside the ERP sidebar's own switcher, and as
 * the portal masthead's own picker. Both places only render this when
 * `user.entityCount > 1` — a principal with one entity has nothing to pick.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronsUpDown, Circle } from 'lucide-react';
import { AFFILIATION_LABELS, type EntityOption, type TenantKind } from '@kaizen/shared';
import { api } from '../lib/api.js';
import { useSession } from '../lib/session.js';
import { words } from '../lib/words.js';

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

/**
 * `dark` matches the ERP sidebar's own chrome (the one place the system uses
 * hand-picked dark hex rather than the light `ink` scale — see `Shell.tsx`'s
 * `ContextSwitcher`). `light` sits on the paper page, as in the portal
 * masthead, and uses the ordinary tokens plus the system's `.glass` material
 * for the floating panel.
 */
export function EntitySwitcher({ variant = 'light' }: { variant?: 'dark' | 'light' }) {
  const { user, switchEntity } = useSession();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: entities = [] } = useQuery({
    queryKey: ['entities'],
    queryFn: () => api.get<{ entities: EntityOption[] }>('/auth/entities').then((r) => r.entities),
    enabled: open,
  });

  if (!user || user.entityCount <= 1) return null;

  const choose = async (tenantId: string) => {
    if (tenantId === user.tenantId) {
      setOpen(false);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await switchEntity(tenantId);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch entity');
    } finally {
      setBusy(false);
    }
  };

  const dark = variant === 'dark';

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          dark
            ? 'flex w-full items-center justify-between gap-2 rounded-full px-2.5 py-1.5 text-left text-xs font-semibold text-[#c9c9ce] transition-colors hover:bg-[#232326] hover:text-white'
            : 'flex items-center gap-2 rounded-full border border-ink-800 bg-ink-900 px-3 py-1.5 text-left text-xs font-semibold text-ink-100 shadow-soft hover:shadow-raised'
        }
        aria-expanded={open}
      >
        <span className="truncate">{user.tenantName}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
      </button>

      {open && (
        <div
          className={
            dark
              ? 'absolute left-0 z-40 mt-1 w-72 rounded-md bg-[#18181c] p-2 shadow-floating'
              : 'glass absolute right-0 z-40 mt-1 w-72 rounded-md p-2'
          }
        >
          <p className={`mb-1 px-1 text-2xs ${dark ? 'text-[#9a9aa3]' : 'text-ink-500'}`}>
            Which entity are you signed in as?
          </p>
          {entities.map((e) => (
            <button
              key={e.tenantId}
              onClick={() => choose(e.tenantId)}
              disabled={busy}
              className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                e.tenantId === user.tenantId
                  ? 'bg-gold text-ink-950'
                  : dark
                    ? 'text-[#c9c9ce] hover:bg-[#232326] hover:text-white'
                    : 'text-ink-200 hover:bg-ink-850'
              }`}
            >
              <span className="flex w-full items-center justify-between gap-2 text-xs font-semibold">
                <span className="truncate">{e.name}</span>
                {e.tenantId === user.tenantId && <Circle className="h-2 w-2 shrink-0 fill-current" aria-hidden />}
              </span>
              <span className="text-2xs opacity-80">
                {KIND_WORDS[e.kind]} · {roleWords(e.roleSlugs)}
                {e.suggested && ' · Suggested from your email'}
              </span>
            </button>
          ))}
          {entities.length === 0 && <p className="px-2 py-2 text-2xs opacity-70">Loading…</p>}
        </div>
      )}
      {error && <p className="mt-1 px-1 text-2xs font-semibold text-band-critical">{error}</p>}
    </div>
  );
}
