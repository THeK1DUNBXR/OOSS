/**
 * Marketing section layout — a secondary, horizontal nav under the main
 * Shell sidebar, one entry per marketing area. A node the viewer's grants
 * would deny is unrendered, exactly like the primary sidebar (Shell.tsx):
 * never shown-and-disabled.
 */

import { NavLink, Outlet } from 'react-router-dom';
import { useSession } from '../../lib/session.js';

interface MarketingNavItem {
  to: string;
  label: string;
  grant: string;
  end?: boolean;
}

const NAV_ITEMS: MarketingNavItem[] = [
  { to: '/marketing', label: 'Overview', grant: 'marketing_analytics:V', end: true },
  { to: '/marketing/campaigns', label: 'Campaigns', grant: 'campaigns:V' },
  { to: '/marketing/calendar', label: 'Calendar', grant: 'campaigns:V' },
  { to: '/marketing/plans', label: 'Plans', grant: 'campaigns:V' },
  { to: '/marketing/audiences', label: 'Audiences', grant: 'audiences:V' },
  { to: '/marketing/consent', label: 'Consent', grant: 'audiences:V' },
  { to: '/marketing/templates', label: 'Templates', grant: 'marketing_templates:V' },
  { to: '/marketing/sends', label: 'Sends', grant: 'marketing_sends:V' },
  { to: '/marketing/journeys', label: 'Journeys', grant: 'marketing_journeys:V' },
  { to: '/marketing/forms', label: 'Forms', grant: 'marketing_forms:V' },
  { to: '/marketing/events', label: 'Events', grant: 'marketing_events:V' },
  { to: '/marketing/assets', label: 'Assets', grant: 'marketing_assets:V' },
  { to: '/marketing/social', label: 'Social', grant: 'marketing_assets:V' },
  { to: '/marketing/referrals', label: 'Referrals', grant: 'marketing_referrals:V' },
  { to: '/marketing/budget', label: 'Budget', grant: 'marketing_budgets:V' },
  { to: '/marketing/analytics', label: 'Analytics', grant: 'marketing_analytics:V' },
  { to: '/marketing/settings', label: 'Settings', grant: 'marketing_settings:V' },
];

export function MarketingShell() {
  const { can } = useSession();
  const items = NAV_ITEMS.filter((item) => can(item.grant));

  return (
    <div>
      <nav className="mb-5 flex flex-wrap gap-1 border-b border-ink-800 pb-0.5" aria-label="Marketing sections">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `-mb-px whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                isActive
                  ? 'border-accent text-ink-50'
                  : 'border-transparent text-ink-400 hover:border-ink-700 hover:text-ink-200'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
