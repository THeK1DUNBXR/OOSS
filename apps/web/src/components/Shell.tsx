/**
 * The rendered shell.
 *
 * Navigation is a projection of the module map, filtered per grant on the
 * server. A node the viewer cannot reach is UNRENDERED, never merely disabled —
 * and badge counts obey the same filter as content, so a badge number is never
 * a permission leak.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { NavNodeView, NotificationView } from '@kaizen/shared';
import { useSession } from '../lib/session.js';
import { api, relative } from '../lib/api.js';

const ICONS: Record<string, string> = {
  gauge: '◎', home: '⌂', inbox: '⇢', columns: '▤', target: '◈', trending: '↗',
  building: '⌗', users: '⧉', message: '✉', package: '❑', calculator: '∑',
  file: '▭', scroll: '≡', clipboard: '✓', shield: '⛨', receipt: '⌸',
  wallet: '▣', coins: '◉', graduation: '⌾', badge: '✦', kanban: '▥',
  alert: '⚠', scale: '⚖', settings: '⚙', map: '⊕', key: '⚿', bot: '⬢',
  activity: '∿', clock: '◷', search: '⌕', layers: '▧',
};

const GROUP_LABELS: Record<string, string> = {
  main: '',
  crm: 'Customer Relationship',
  commercial: 'Commercial',
  finance: 'Finance',
  delivery: 'Delivery & Education',
  governance: 'Governance',
  admin: 'Platform',
};

export function Shell() {
  const { user, nav, signOut } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Fixed group order, so the shell reads the way the work reads: your own
  // surface first, then the domains, then the platform underneath them.
  const GROUP_ORDER = ['main', 'crm', 'commercial', 'finance', 'delivery', 'governance', 'admin'];

  const grouped = useMemo(() => {
    const map = new Map<string, NavNodeView[]>();
    for (const node of nav) {
      map.set(node.group, [...(map.get(node.group) ?? []), node]);
    }
    return [...map.entries()].sort(
      (a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]),
    );
  }, [nav]);

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationView[]>('/auth/notifications'),
    refetchInterval: 60_000,
  });
  const unread = notifications.filter((n) => !n.readAt).length;

  // Command palette. Every result still passes the five-axis filter at render
  // time on the server — the palette is a router, never a side channel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setSwitcherOpen(false);
        setNotifOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  if (!user) return null;

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-ink-850 bg-ink-900">
        <div className="flex items-center gap-2 border-b border-ink-850 px-4 py-3.5">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-accent text-sm font-bold text-white">K</div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-ink-50">Kaizen</p>
            <p className="truncate text-2xs text-ink-500">{user.tenantName}</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {grouped.map(([group, nodes]) => (
            <div key={group} className="mb-4">
              {GROUP_LABELS[group] && (
                <p className="mb-1 px-2 text-2xs font-semibold uppercase tracking-wider text-ink-500">
                  {GROUP_LABELS[group]}
                </p>
              )}
              {nodes.map((node) => (
                <NavLink
                  key={node.key}
                  to={node.path}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
                      isActive || location.pathname.startsWith(`${node.path}/`)
                        ? 'bg-accent/15 font-medium text-ink-50'
                        : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
                    }`
                  }
                >
                  <span className="w-4 text-center text-ink-500">{ICONS[node.icon] ?? '·'}</span>
                  <span className="truncate">{node.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="border-t border-ink-850 p-2">
          <button
            onClick={() => setSwitcherOpen((v) => !v)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-ink-850"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-700 text-2xs font-semibold text-ink-100">
              {user.fullName.split(' ').map((n) => n[0]).slice(0, 2).join('')}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-ink-100">{user.fullName}</p>
              {/* The persistent "you are acting as" affordance the non-union
                  rule makes necessary. */}
              <p className="truncate text-2xs text-ink-500">
                acting as {user.roleSlug.replace(/_/g, ' ')}
              </p>
            </div>
            <span className="text-ink-500">⇅</span>
          </button>

          {switcherOpen && (
            <ContextSwitcher onDone={() => setSwitcherOpen(false)} />
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-ink-850 bg-ink-900 px-5 py-2.5">
          <button
            onClick={() => setSearchOpen(true)}
            className="flex flex-1 items-center gap-2 rounded-md border border-ink-800 bg-ink-950 px-3 py-1.5 text-left text-xs text-ink-500 hover:border-ink-700"
          >
            <span>⌕</span>
            <span className="flex-1">Search people, accounts, deals, agreements…</span>
            <kbd className="rounded border border-ink-700 px-1 py-0.5 text-2xs text-ink-500">⌘K</kbd>
          </button>

          <div className="relative">
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative rounded-md border border-ink-800 bg-ink-950 px-2.5 py-1.5 text-xs text-ink-300 hover:border-ink-700"
            >
              ✉
              {unread > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-2xs font-semibold text-white">
                  {unread}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 z-40 mt-2 w-96 rounded-lg border border-ink-700 bg-ink-900 shadow-2xl">
                <div className="border-b border-ink-800 px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-ink-400">
                  Notifications
                </div>
                <div className="max-h-96 overflow-y-auto">
                  {notifications.length === 0 && (
                    <p className="px-3 py-6 text-center text-xs text-ink-500">Nothing waiting.</p>
                  )}
                  {notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={async () => {
                        await api.post(`/auth/notifications/${n.id}/read`);
                        setNotifOpen(false);
                        if (n.drillPath) navigate(n.drillPath);
                      }}
                      className={`block w-full border-b border-ink-850 px-3 py-2.5 text-left hover:bg-ink-850 ${
                        n.readAt ? 'opacity-60' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-medium text-ink-100">{n.title}</p>
                        <span className="shrink-0 text-2xs text-ink-500">{relative(n.createdAt)}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-2xs text-ink-400">{n.body}</p>
                      <span className="mono mt-1 inline-block">{n.priority.replace(/^N\d_/, '').toLowerCase()}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <button onClick={signOut} className="btn-ghost">
            Sign out
          </button>
        </header>

        <main className="flex-1 overflow-y-auto px-6 py-5">
          <Outlet />
        </main>
      </div>

      {searchOpen && <CommandPalette onClose={() => setSearchOpen(false)} />}
    </div>
  );
}

function ContextSwitcher({ onDone }: { onDone: () => void }) {
  const { user, switchTo } = useSession();
  const [stepUpFor, setStepUpFor] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const handle = async (affiliationId: string, requiresStepUp: boolean) => {
    setError(null);
    if (requiresStepUp && stepUpFor !== affiliationId) {
      setStepUpFor(affiliationId);
      return;
    }
    try {
      await switchTo(affiliationId, requiresStepUp ? password : undefined);
      setPassword('');
      setStepUpFor(null);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Switch failed');
    }
  };

  return (
    <div className="mt-1 rounded-md border border-ink-700 bg-ink-850 p-2">
      <p className="mb-1.5 px-1 text-2xs text-ink-500">
        Which of your relationships are you answerable as?
      </p>
      {user.affiliations.map((a) => (
        <div key={a.id}>
          <button
            onClick={() => handle(a.id, a.requiresStepUp)}
            className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
              a.id === user.activeAffiliationId ? 'bg-accent/15 text-ink-50' : 'text-ink-300 hover:bg-ink-800'
            }`}
          >
            <span className="truncate capitalize">{a.roleSlug.replace(/_/g, ' ')}</span>
            <span className="flex shrink-0 items-center gap-1">
              {a.requiresStepUp && <span title="Requires step-up re-authentication">⛨</span>}
              {a.id === user.activeAffiliationId && <span className="text-accent">●</span>}
            </span>
          </button>
          {stepUpFor === a.id && (
            <div className="mt-1 space-y-1.5 rounded bg-ink-900 p-2">
              <p className="text-2xs text-ink-400">
                A privileged context requires step-up re-authentication before the switch commits.
              </p>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handle(a.id, true)}
                placeholder="Password"
                className="input py-1 text-xs"
                autoFocus
              />
              <button onClick={() => handle(a.id, true)} className="btn-primary w-full">
                Verify and switch
              </button>
            </div>
          )}
        </div>
      ))}
      {error && <p className="mt-1 px-1 text-2xs text-band-critical">{error}</p>}
    </div>
  );
}

interface SearchResult {
  type: string;
  id: string;
  label: string;
  recordCode: string;
  path: string;
  sub: string;
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const { nav } = useSession();

  useEffect(() => inputRef.current?.focus(), []);

  const { data } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<{ results: SearchResult[] }>(`/crm/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
  });

  // Nav synonyms route a natural-language phrase to the right surface.
  const navMatches = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term.length < 2) return [];
    return nav
      .filter((n) => n.label.toLowerCase().includes(term) || n.searchSynonyms.some((s) => s.includes(term)))
      .slice(0, 5);
  }, [q, nav]);

  const go = (path: string) => {
    navigate(path);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 pt-24" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-lg border border-ink-700 bg-ink-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search records or jump to a surface…"
          className="w-full border-b border-ink-800 bg-transparent px-4 py-3 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
        />
        <div className="max-h-96 overflow-y-auto p-2">
          {navMatches.length > 0 && (
            <>
              <p className="px-2 py-1 text-2xs uppercase tracking-wide text-ink-500">Surfaces</p>
              {navMatches.map((n) => (
                <button key={n.key} onClick={() => go(n.path)} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-xs text-ink-200 hover:bg-ink-850">
                  <span className="text-ink-500">{ICONS[n.icon] ?? '·'}</span>
                  {n.label}
                </button>
              ))}
            </>
          )}
          {data?.results && data.results.length > 0 && (
            <>
              <p className="px-2 py-1 text-2xs uppercase tracking-wide text-ink-500">Records</p>
              {data.results.map((r) => (
                <button key={`${r.type}:${r.id}`} onClick={() => go(r.path)} className="flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-ink-850">
                  <span className="mono w-28 shrink-0">{r.recordCode}</span>
                  <span className="flex-1 truncate text-xs text-ink-100">{r.label}</span>
                  <span className="shrink-0 text-2xs text-ink-500">{r.sub || r.type}</span>
                </button>
              ))}
            </>
          )}
          {q.trim().length >= 2 && !data?.results?.length && navMatches.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-ink-500">
              Nothing matches within what you may reach. Every candidate passes the five-axis filter before it is returned.
            </p>
          )}
          {q.trim().length < 2 && (
            <p className="px-3 py-6 text-center text-xs text-ink-500">Type at least two characters.</p>
          )}
        </div>
      </div>
    </div>
  );
}
