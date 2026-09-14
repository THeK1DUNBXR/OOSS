/**
 * The portal shell — the shareholder/board surface's own chrome.
 *
 * No ERP sidebar renders here, ever: a portal-archetype principal gets this
 * shell wherever they open the app (rule b of `lib/surface.ts`), and an ERP
 * role opening the portal host gets this shell too, with an empty state
 * rather than a sidebar they hold no grants for (plan §6, phase 0 item 5).
 *
 * The masthead is the one place this shell uses `.glass` — real content
 * (the outlet) scrolls under it, which is what the design system reserves
 * translucency for (DESIGN.md, "The Functional Glass Rule").
 */

import { NavLink, Outlet } from 'react-router-dom';
import type { NavNodeView } from '@kaizen/shared';
import { useSession } from '../lib/session.js';
import { words } from '../lib/words.js';
import { BuildFootnote } from '../components/BuildFootnote.js';
import { EntitySwitcher } from '../components/EntitySwitcher.js';
import { EmptyState } from '../components/ui.js';

export function PortalShell() {
  const { user, nav, signOut } = useSession();
  if (!user) return null;

  const sections: NavNodeView[] = nav.filter((n) => n.group === 'portal');

  return (
    <div className="flex min-h-full flex-col">
      <header className="glass sticky top-0 z-20 px-6 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-100">{user.tenantName}</p>
            <p className="truncate text-2xs text-ink-500">
              {user.fullName} · {words(user.roleSlug)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {user.entityCount > 1 && <EntitySwitcher variant="light" />}
            <button onClick={signOut} className="btn-ghost">
              Sign out
            </button>
          </div>
        </div>

        {sections.length > 0 && (
          <nav className="mt-3 flex flex-wrap gap-1">
            {sections.map((n) => (
              <NavLink
                key={n.key}
                to={n.path}
                className={({ isActive }) =>
                  `rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                    isActive ? 'bg-gold text-ink-100' : 'text-ink-500 hover:bg-ink-850 hover:text-ink-100'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>

      <main className="flex-1 px-6 py-6">
        {sections.length === 0 ? (
          // An ERP role holds no `portal:*` grants and so was never given a
          // portal nav node — this is what that looks like, rather than a
          // blank page or a permission error.
          <EmptyState
            message="This entity has not given you a shareholder or board view."
            hint="Open the workspace instead."
          />
        ) : (
          <Outlet />
        )}
        <BuildFootnote />
      </main>
    </div>
  );
}
