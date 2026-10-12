import type { NavNodeView, SessionUser } from '@kaizen/shared';
import { vi } from 'vitest';

/**
 * Stubs fetch for the session endpoints the shell reads on load. Component
 * tests that need a signed-in shell go through this, so the shell is rendered
 * by the real SessionProvider rather than a hand-built context.
 */

export const testUser: SessionUser = {
  userId: 'user-1',
  principalId: 'principal-1',
  personId: 'person-1',
  fullName: 'Asha Rao',
  email: 'asha@example.test',
  tenantId: 'tenant-1',
  tenantName: 'Example Holdings',
  tenantKind: 'holding',
  parentTenantId: null,
  entityCount: 1,
  activeAffiliationId: 'affiliation-1',
  roleSlug: 'finance-lead',
  archetype: 'workspace',
  classificationCeiling: 'internal',
  affiliations: [],
  grants: [],
  authorityGrants: [],
  branch: null,
};

export const testNav: NavNodeView[] = [
  { key: 'workspace', label: 'Workspace', icon: 'home', path: '/workspace', group: 'core', searchSynonyms: [] },
  { key: 'exceptions', label: 'Exceptions', icon: 'alert', path: '/exceptions', group: 'core', searchSynonyms: [] },
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * With `signedIn` false the refresh cookie is refused, which is what a visitor
 * with no session sees and what drops the app onto the sign-in screen.
 */
export function stubSessionApi({
  signedIn = true,
  loginResponse,
}: { signedIn?: boolean; loginResponse?: unknown } = {}) {
  const answers: Record<string, unknown> = {
    '/api/auth/me': testUser,
    '/api/auth/navigation': testNav,
    '/api/auth/notifications': [],
  };
  if (loginResponse !== undefined) answers['/api/auth/login'] = loginResponse;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/auth/refresh') {
      return signedIn
        ? json(200, { token: 'test-token' })
        : json(401, { error: { code: 'NO_SESSION', message: 'no session' } });
    }
    if (path in answers) return json(200, answers[path]);
    return json(404, { error: { code: 'NOT_STUBBED', message: `no stub for ${path}` } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
