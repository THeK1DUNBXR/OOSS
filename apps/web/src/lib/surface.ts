/**
 * Which shell the app renders: the ERP sidebar, or the portal masthead.
 *
 * Never a tenant or a permission decision — those stay server-side, exactly
 * as the plan requires (equity-portal plan §3.1). This only decides which
 * chrome wraps whatever navigation the server actually returned, by one of
 * three rules, in order:
 *
 *   (a) the hostname is one of `surfaceHosts.portal`, read from
 *       `/meta/version` — the same query `BuildFootnote` makes, sharing its
 *       cache key so this never doubles the request;
 *   (b) the signed-in principal's active role resolves to the `portal`
 *       archetype, wherever they opened the app;
 *   (c) development only — `?surface=portal` in the URL, so a portal screen
 *       can be reached on localhost without a second hostname. The choice is
 *       written to `sessionStorage` so a client-side navigation away from the
 *       query string does not fall back to the ERP shell mid-session.
 *
 * `/meta/version` requires a session (see `apps/api/src/routes/index.ts`), so
 * rule (a) only takes effect once a principal is signed in — which is also
 * the only point any of this matters, since `Routed()` shows the sign-in
 * form, not a shell, until `user` exists.
 */

import { useQuery } from '@tanstack/react-query';
import type { SessionUser } from '@kaizen/shared';
import { api } from './api.js';

export type Surface = 'erp' | 'portal';

const DEV_SURFACE_KEY = 'kaizen.devSurface';

interface VersionSurfaces {
  surfaceHosts?: { portal: string[] };
}

function devPortalOverride(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    if (new URLSearchParams(window.location.search).get('surface') === 'portal') {
      sessionStorage.setItem(DEV_SURFACE_KEY, 'portal');
    }
    return sessionStorage.getItem(DEV_SURFACE_KEY) === 'portal';
  } catch {
    // A private window without storage just does not get the dev override —
    // it still reaches the portal by hostname or archetype like anyone else.
    return false;
  }
}

export function useSurface(user: SessionUser | null): Surface {
  const { data } = useQuery({
    queryKey: ['version'],
    queryFn: () => api.get<VersionSurfaces>('/meta/version'),
    enabled: Boolean(user),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  if (user?.archetype === 'portal') return 'portal';
  if (devPortalOverride()) return 'portal';

  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  if (data?.surfaceHosts?.portal?.includes(hostname)) return 'portal';

  return 'erp';
}
