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
import { words } from '../lib/words.js';
import { FirstRun } from './FirstRun.js';
import { SetupBanner } from '../pages/Start.js';

const ICONS: Record<string, string> = {
  gauge: '◎', home: '⌂', inbox: '⇢', columns: '▤', target: '◈', trending: '↗',
  building: '⌗', users: '⧉', message: '✉', package: '❑', calculator: '∑',
  file: '▭', scroll: '≡', clipboard: '✓', shield: '⛨', receipt: '⌸',
  wallet: '▣', coins: '◉', graduation: '⌾', badge: '✦', kanban: '▥',
  alert: '⚠', scale: '⚖', settings: '⚙', map: '⊕', key: '⚿', bot: '⬢',
  activity: '∿', clock: '◷', search: '⌕', layers: '▧',
  sparkle: '✧', lock: '⚿', list: '☰', book: '▤',
};

// Ordinary business words are kept as they are — a salesperson knows what a
// lead, a pipeline and a quote are, and renaming those would help nobody.
// What gets translated is the engineering vocabulary underneath.
const GROUP_LABELS: Record<string, string> = {
  main: '',
  money: 'Money',
  people: 'People',
  customers: 'Customers',
  delivery: 'Selling & Delivering',
  setup: 'Set up',
};

/**
 * Groups that start closed.
 *
 * Set-up is where you go twice a year — to import a year of books, change who
 * can do what, or look at the audit trail — and having eleven of those entries
 * permanently in the sidebar was most of what made this product feel heavy.
 * It opens on click and stays open for the session.
 */
const COLLAPSED_BY_DEFAULT = new Set(['setup']);

export function Shell() {
  const { user, nav, signOut } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Fixed group order, so the shell reads the way the work reads: your own
  // surface first, then the domains, then the platform underneath them.
  const GROUP_ORDER = ['main', 'money', 'people', 'customers', 'delivery', 'setup'];

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

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
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="sidebar-mark">K</div>
          <div className="min-w-0">
            <p className="truncate font-display text-base font-black uppercase leading-tight tracking-tight text-white">
              KaiERP
            </p>
            <p className="mt-0.5 truncate text-[10px] font-bold uppercase tracking-[0.09em] text-[#9a9aa3]">
              {user.tenantName}
            </p>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-px overflow-y-auto px-2.5 py-3">
          {grouped.map(([group, nodes]) => {
            const collapsible = COLLAPSED_BY_DEFAULT.has(group);
            // A collapsed group still opens itself when you are inside it, so
            // navigating to a set-up screen never leaves the sidebar
            // disagreeing with the page.
            const holdsCurrent = nodes.some(
              (n) => location.pathname === n.path || location.pathname.startsWith(`${n.path}/`),
            );
            const open = !collapsible || (openGroups[group] ?? holdsCurrent);

            return (
              <div key={group} className="contents">
                {GROUP_LABELS[group] &&
                  (collapsible ? (
                    <button
                      onClick={() => setOpenGroups((g) => ({ ...g, [group]: !open }))}
                      className="sidebar-group flex w-full items-center justify-between hover:text-white"
                      aria-expanded={open}
                    >
                      <span>{GROUP_LABELS[group]}</span>
                      <span aria-hidden className="text-[9px] opacity-70">{open ? '▾' : '▸'}</span>
                    </button>
                  ) : (
                    <p className="sidebar-group">{GROUP_LABELS[group]}</p>
                  ))}
                {open &&
                  nodes.map((node) => (
                    <NavLink
                      key={node.key}
                      to={node.path}
                      className={({ isActive }) =>
                        `sidebar-link ${
                          isActive || location.pathname.startsWith(`${node.path}/`)
                            ? 'sidebar-link-active'
                            : ''
                        }`
                      }
                    >
                      <span className="w-[18px] text-center opacity-85">{ICONS[node.icon] ?? '·'}</span>
                      <span className="truncate">{node.label}</span>
                    </NavLink>
                  ))}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <button
            onClick={() => setSwitcherOpen((v) => !v)}
            className="flex w-full items-center gap-2 rounded-full px-2 py-2 text-left transition-colors hover:bg-[#232326]"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-gold bg-gold font-display text-2xs font-black text-[#0F0F12]">
              {user.fullName.split(' ').map((n) => n[0]).slice(0, 2).join('')}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-white">{user.fullName}</p>
              {/* The persistent "you are acting as" affordance the non-union
                  rule makes necessary. */}
              <p className="truncate text-2xs text-[#9a9aa3]">
                signed in as {words(user.roleSlug).toLowerCase()}
              </p>
            </div>
            <span className="text-[#9a9aa3]">⇅</span>
          </button>

          {switcherOpen && (
            <ContextSwitcher onDone={() => setSwitcherOpen(false)} />
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-ink-700 bg-ink-900 px-6 py-3">
          <button
            onClick={() => setSearchOpen(true)}
            className="flex flex-1 items-center gap-2 rounded-full border-[1.5px] border-ink-700 bg-ink-950 px-4 py-2 text-left text-xs text-ink-500 hover:border-ink-100"
          >
            <span>⌕</span>
            <span className="flex-1">Search people, accounts, deals, agreements…</span>
            <kbd className="rounded-sm border border-ink-700 px-1.5 py-0.5 font-mono text-2xs text-ink-500">⌘K</kbd>
          </button>

          <div className="relative">
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative rounded-full border-2 border-ink-100 bg-transparent px-3 py-1.5 text-xs text-ink-100 hover:bg-ink-100 hover:text-ink-950"
            >
              ✉
              {unread > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border border-ink-100 bg-gold px-1 font-mono text-2xs font-black text-ink-100">
                  {unread}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 z-40 mt-2 w-96 rounded-lg border-[3px] border-ink-100 bg-ink-900">
                <div className="border-b-2 border-ink-100 px-3 py-2 text-2xs font-extrabold uppercase tracking-wide text-ink-500">
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
                      className={`block w-full border-b border-ink-700 px-3 py-2.5 text-left last:border-b-0 hover:bg-ink-850 ${
                        n.readAt ? 'opacity-60' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold text-ink-100">{n.title}</p>
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
          {/* Both of these are redundant on the Getting Started screen: it is
              the orientation, at more length and without a dialog to dismiss. */}
          {location.pathname !== '/start' && <FirstRun />}
          {location.pathname !== '/start' && <SetupBanner />}
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
    <div className="mt-1 rounded-sm border-2 border-[#3a3a40] bg-[#18181c] p-2">
      <p className="mb-1.5 px-1 text-2xs text-[#9a9aa3]">
        Which of your relationships are you answerable as?
      </p>
      {user.affiliations.map((a) => (
        <div key={a.id}>
          <button
            onClick={() => handle(a.id, a.requiresStepUp)}
            className={`flex w-full items-center justify-between gap-2 rounded-full px-2.5 py-1.5 text-left text-xs font-semibold transition-colors ${
              a.id === user.activeAffiliationId
                ? 'bg-gold text-[#0F0F12]'
                : 'text-[#c9c9ce] hover:bg-[#232326] hover:text-white'
            }`}
          >
            <span className="truncate capitalize">{a.roleSlug.replace(/_/g, ' ')}</span>
            <span className="flex shrink-0 items-center gap-1">
              {a.requiresStepUp && <span title="You will be asked to confirm your password again before this goes through">⛨</span>}
              {a.id === user.activeAffiliationId && <span>●</span>}
            </span>
          </button>
          {stepUpFor === a.id && (
            <div className="mt-1 space-y-1.5 rounded-sm bg-[#232326] p-2">
              <p className="text-2xs text-[#9a9aa3]">
                A privileged context requires step-up re-authentication before the switch commits.
              </p>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handle(a.id, true)}
                placeholder="Password"
                className="w-full rounded-sm border-[1.5px] border-[#3a3a40] bg-[#0F0F12] px-2.5 py-1 text-xs text-white placeholder:text-[#6b6b74] focus:border-gold focus:outline-none"
                autoFocus
              />
              <button onClick={() => handle(a.id, true)} className="btn-gold btn-sm w-full">
                Verify and switch
              </button>
            </div>
          )}
        </div>
      ))}
      {error && <p className="mt-1 px-1 text-2xs font-semibold text-[#ff8b80]">{error}</p>}
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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#0F0F12]/55 p-4 pt-24" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-lg border-[3px] border-ink-100 bg-ink-900" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search for a person, company, deal or agreement…"
          className="w-full border-b-2 border-ink-100 bg-transparent px-4 py-3.5 text-sm text-ink-100 placeholder:text-ink-500 focus:outline-none"
        />
        <div className="max-h-96 overflow-y-auto p-2">
          {navMatches.length > 0 && (
            <>
              <p className="section-title px-2 py-1">Surfaces</p>
              {navMatches.map((n) => (
                <button key={n.key} onClick={() => go(n.path)} className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-xs text-ink-200 hover:bg-ink-850">
                  <span className="text-ink-500">{ICONS[n.icon] ?? '·'}</span>
                  {n.label}
                </button>
              ))}
            </>
          )}
          {data?.results && data.results.length > 0 && (
            <>
              <p className="section-title px-2 py-1">Records</p>
              {data.results.map((r) => (
                <button key={`${r.type}:${r.id}`} onClick={() => go(r.path)} className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left hover:bg-ink-850">
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
