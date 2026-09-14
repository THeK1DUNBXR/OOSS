/**
 * The one portal page that is real in phase 0, not a placeholder: the entity
 * picker as a screen rather than a dropdown, for holding-level principals
 * (the node carries `group:V`, so only they are given it — plan §6, phase 0
 * item 5). A tile switches entity exactly as the masthead's own picker does.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AFFILIATION_LABELS, type EntityOption, type GroupStructureView, type TenantKind } from '@kaizen/shared';
import { api, dateTime } from '../../lib/api.js';
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

/**
 * A holding-level portal user (plan §6, phase 2 item 2): the same group
 * structure and per-entity tiles the ERP `Group` screen shows, with the ERP
 * chrome removed. Reads only `/group/*`, exactly as the ERP screen does.
 */
function GroupTiles() {
  const { switchEntity } = useSession();
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['portal-group-structure'],
    queryFn: () => api.get<GroupStructureView>('/group/structure'),
  });

  if (isLoading || !data) return <Loading label="Reading the group" />;

  const children = data.nodes.filter((n) => n.tenantId !== data.self.tenantId && n.kind !== 'not_yet_incorporated');

  if (children.length === 0) {
    return <EmptyState message="This company has no subsidiaries." />;
  }

  const open = async (tenantId: string) => {
    setBusy(tenantId);
    try {
      await switchEntity(tenantId);
    } catch {
      window.location.assign(`/equity/group/${tenantId}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {children.map((n) => (
        <button
          key={n.tenantId}
          onClick={() => n.tenantId && open(n.tenantId)}
          disabled={busy !== null}
          className="flex flex-col items-start gap-1 rounded-lg border border-ink-800 bg-ink-900 p-4 text-left shadow-raised transition-all duration-150 hover:-translate-y-px hover:shadow-floating disabled:opacity-60"
        >
          <span className="text-sm font-semibold text-ink-100">{n.name}</span>
          <span className="text-2xs uppercase tracking-wide text-ink-500">{n.badge ?? n.kind}</span>
          <span className="mt-1 text-2xs text-ink-500">
            {n.publishedAt ? `as published ${dateTime(n.publishedAt)}` : 'Not yet published'}
          </span>
          {n.stale && <span className="mt-1 chip border-band-critical/40 bg-band-critical/10 text-band-critical">Stale</span>}
          {busy === n.tenantId && <span className="mt-1 text-2xs text-ink-500">Opening…</span>}
        </button>
      ))}
    </div>
  );
}

function SubsidiaryEntityList() {
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

/**
 * A holding-level user (`user.tenantKind === 'holding'`) sees the group
 * structure and tiles; anyone else sees the plain entity list phase 0 built
 * (plan §6, phase 2: "the portal's Entities page which is the same data
 * with the ERP chrome removed").
 */
export function Entities() {
  const { user } = useSession();

  if (user?.tenantKind === 'holding') {
    return (
      <div>
        <PageHeader title="Entities" subtitle="Each subsidiary's own published summary. Tap one to open it, where your relationships there allow it." />
        <GroupTiles />
      </div>
    );
  }

  return <SubsidiaryEntityList />;
}
