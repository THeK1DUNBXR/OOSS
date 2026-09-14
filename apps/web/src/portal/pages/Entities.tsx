/**
 * The one portal page that is real in phase 0, not a placeholder: the entity
 * picker as a screen rather than a dropdown, for holding-level principals
 * (the node carries `group:V`, so only they are given it — plan §6, phase 0
 * item 5). A tile switches entity exactly as the masthead's own picker does.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AFFILIATION_LABELS, type EntityOption, type TenantKind } from '@kaizen/shared';
import { api } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { words } from '../../lib/words.js';
import { EmptyState, Loading, PageHeader } from '../../components/ui.js';

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

export function Entities() {
  const { user, switchEntity } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: entities, isLoading } = useQuery({
    queryKey: ['entities'],
    queryFn: () => api.get<{ entities: EntityOption[] }>('/auth/entities').then((r) => r.entities),
  });

  const choose = async (tenantId: string) => {
    if (tenantId === user?.tenantId) return;
    setError(null);
    setBusy(tenantId);
    try {
      await switchEntity(tenantId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch entity');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader title="Entities" subtitle="Every entity you hold a shareholder or board relationship with." />
      {isLoading && <Loading label="Reading your entities" />}
      {!isLoading && (!entities || entities.length === 0) && (
        <EmptyState message="No entity relationship has been recorded for you yet." />
      )}
      {!isLoading && entities && entities.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {entities.map((e) => (
            <button
              key={e.tenantId}
              onClick={() => choose(e.tenantId)}
              disabled={busy !== null}
              className={`flex flex-col items-start gap-1 rounded-lg border border-ink-800 bg-ink-900 p-4 text-left shadow-raised transition-all duration-150 hover:-translate-y-px hover:shadow-floating disabled:opacity-60 ${
                e.tenantId === user?.tenantId ? 'ring-2 ring-gold' : ''
              }`}
            >
              <span className="text-sm font-semibold text-ink-100">{e.name}</span>
              <span className="text-2xs uppercase tracking-wide text-ink-500">{KIND_WORDS[e.kind]}</span>
              <span className="mt-1 text-xs text-ink-400">{roleWords(e.roleSlugs)}</span>
              {e.tenantId === user?.tenantId && (
                <span className="mt-1 text-2xs font-semibold text-accent-soft">Currently open</span>
              )}
              {busy === e.tenantId && <span className="mt-1 text-2xs text-ink-500">Opening…</span>}
            </button>
          ))}
        </div>
      )}
      {error && <p className="mt-3 text-2xs text-band-critical">{error}</p>}
    </div>
  );
}
