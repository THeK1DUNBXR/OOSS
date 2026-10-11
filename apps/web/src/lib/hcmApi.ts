/**
 * Typed endpoints for the HR and People screens: the workforce directory and
 * org chart, the approval delegations inbox, the team leave calendar, and the
 * CRM people and merge queue that the People screen shows beside them.
 *
 * One object per domain on the single `api` client. Paths are written once
 * here; a screen that reads a field the response does not carry fails to
 * typecheck instead of rendering undefined. Shapes that exist only as the
 * route's own row or aggregate (no shared view type) are declared below, next
 * to the call that returns them, with the handler they mirror cited.
 */

import type { InteractionView, OrgChartNode, PersonView } from '@kaizen/shared';
import { api } from './api.js';

// ---------------------------------------------------------------------------
// Workforce
// ---------------------------------------------------------------------------

/** One row of `GET /hcm/workforce/directory` (domains/hcm/workforce.ts directorySearch). */
export interface DirectoryRow {
  employmentRelationshipId: string;
  recordCode: string;
  status: string;
  person: { id: string; fullName: string; primaryEmail: string | null; primaryPhone: string | null };
  title: string | null;
  orgUnit: string | null;
  location: { name: string; city: string | null } | null;
}

export interface OrgUnitOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Workflow: delegations of authority
// ---------------------------------------------------------------------------

/** One row of `GET /hcm/workflow/delegations` (domains/hcm/workflow.ts listDelegations). */
export interface DelegationRow {
  id: string;
  fromPartyId: string;
  toPartyId: string;
  fromDate: string;
  toDate: string;
  scope: string;
  note: string | null;
  revokedAt: string | null;
}

export interface CreateDelegationBody {
  toPartyId: string;
  fromDate: string;
  toDate: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Leave: team calendar (domains/hcm/leavepolicy.ts teamCalendar)
// ---------------------------------------------------------------------------

export interface TeamCalendarEntry {
  employmentRelationshipId: string;
  fullName: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  status: string;
}

export interface TeamCalendarResult {
  month: string;
  entries: TeamCalendarEntry[];
  holidays: Array<{ date: string; name: string; kind: string }>;
}

// ---------------------------------------------------------------------------
// People (CRM): directory search, person detail and the merge queue
// ---------------------------------------------------------------------------

export type PeopleGroup = 'all' | 'student' | 'employee' | 'contact' | 'none';

/** `GET /crm/people`: the list view, with counts for each group filter. */
export interface PeopleListResponse {
  items: PersonListItem[];
  total: number;
  counts: Record<PeopleGroup, number>;
}

/**
 * A row of the people list. Mirrors `PersonView` in packages/shared/src/api.ts;
 * the list screen reads only the fields below, so it is typed as a view and not
 * re-declared here.
 */
export type PersonListItem = PersonView;

export interface PersonAffiliationRow {
  id: string;
  affiliationType: string;
  roleSlug: string | null;
  counterpartyName: string | null;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  statutoryRetentionFloor: boolean;
}

/**
 * `GET /crm/people/:id` returns the raw Person row with its affiliations, not
 * the `PersonView` the list returns. The two differ: the row carries
 * `mergedIntoId` and `source` where the view carries `mergedInto` and no source.
 */
export interface PersonDetailRow {
  id: string;
  recordCode: string;
  fullName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  dedupeStatus: string;
  mergedIntoId: string | null;
  source: string;
  createdAt: string;
  affiliations: PersonAffiliationRow[];
}

export interface PersonRelationshipRow {
  id: string;
  relationshipType: string;
  role: string | null;
  strength: string;
  status: string;
}

/** `GET /crm/people/:id` (routes/crm.routes.ts). */
export interface PersonDetailView {
  person: PersonDetailRow;
  relationships: PersonRelationshipRow[];
  timeline: InteractionView[];
}

/** One row of `GET /crm/merge-candidates` (routes/crm.routes.ts). */
export interface MergeCandidateRow {
  id: string;
  confidence: number;
  matchedOn: string[];
  raisedReason: string;
  state: string;
  createdAt: string;
  incomingPayload: Record<string, unknown> | null;
  candidate: {
    id: string;
    recordCode: string;
    fullName: string;
    affiliationBadges: string[];
    statutoryRetentionFloor: boolean;
  } | null;
}

export const hcmApi = {
  workforce: {
    directory: (q: string) =>
      api.get<DirectoryRow[]>(`/hcm/workforce/directory${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    orgChart: () => api.get<OrgChartNode[]>('/hcm/workforce/org-chart'),
  },
  orgUnits: {
    list: () => api.get<OrgUnitOption[]>('/hr/org-units'),
  },
  delegations: {
    list: () => api.get<DelegationRow[]>('/hcm/workflow/delegations'),
    create: (body: CreateDelegationBody) => api.post('/hcm/workflow/delegations', body),
    revoke: (id: string) => api.post(`/hcm/workflow/delegations/${id}/revoke`),
  },
  leave: {
    teamCalendar: (month: string, orgUnitId: string) =>
      api.get<TeamCalendarResult>(
        `/hcm/leavepolicy/team-calendar?month=${month}${orgUnitId ? `&orgUnitId=${orgUnitId}` : ''}`,
      ),
  },
  people: {
    list: (q: string, group: PeopleGroup) =>
      api.get<PeopleListResponse>(`/crm/people?q=${encodeURIComponent(q)}&affiliation=${group}`),
    get: (id: string) => api.get<PersonDetailView>(`/crm/people/${id}`),
    interactions: () => api.get<InteractionView[]>('/crm/interactions?limit=80'),
    mergeCandidates: () => api.get<MergeCandidateRow[]>('/crm/merge-candidates'),
    resolveMergeCandidate: (id: string, disposition: string, note: string) =>
      api.post(`/crm/merge-candidates/${id}/resolve`, { disposition, note }),
  },
};
