/**
 * Typed endpoints for the Technology (IT) vendors and contracts screens.
 *
 * One object per domain, built on the single `api` client in `api.ts`. Each
 * path is written once here and its response is the view type the API's
 * domain file exports from `@kaizen/shared`, so a screen that reads a field
 * the view does not carry fails to typecheck instead of rendering undefined.
 *
 * The rest of the web app still calls `api.get<any>` directly; converting a
 * domain means adding its module here, not touching `api.ts`.
 */

import type {
  ItVendorContractSummary,
  ItVendorContractTransitionResult,
  ItVendorContractView,
  ItVendorSummary,
  ItVendorView,
  VendorContractStatus,
  VendorEvent,
} from '@kaizen/shared';
import { api } from './api.js';

/**
 * One assessment as the vendor detail route returns it: the Prisma row, with
 * dates as JSON strings. No shared view type exists for it yet, so this mirrors
 * `ItVendorRiskAssessment` in `apps/api/prisma/schema/`.
 */
export interface ItVendorRiskAssessmentRow {
  id: string;
  tenantId: string;
  vendorId: string;
  assessedAt: string;
  assessorPartyId: string;
  score: number | null;
  outcome: string;
  questionnaire: unknown;
  notes: string | null;
  evidenceDocumentId: string | null;
  createdAt: string;
}

/** `GET /it/vendors/:id` adds the assessment history and the vendor's contracts to the list view. */
export type ItVendorDetailView = ItVendorView & {
  riskAssessments: ItVendorRiskAssessmentRow[];
  contracts: ItVendorContractView[];
};

export const itVendorApi = {
  vendors: {
    list: () => api.get<ItVendorView[]>('/it/vendors'),
    summary: () => api.get<ItVendorSummary>('/it/vendors/summary'),
    get: (id: string) => api.get<ItVendorDetailView>(`/it/vendors/${id}`),
    transition: (id: string, event: VendorEvent) => api.post<ItVendorView>(`/it/vendors/${id}/transition`, { event }),
  },
  contracts: {
    list: () => api.get<ItVendorContractView[]>('/it/contracts'),
    forVendor: (vendorId: string) => api.get<ItVendorContractView[]>(`/it/contracts?vendorId=${vendorId}`),
    summary: () => api.get<ItVendorContractSummary>('/it/contracts/summary'),
    get: (id: string) => api.get<ItVendorContractView>(`/it/contracts/${id}`),
    transition: (id: string, toStatus: VendorContractStatus) =>
      api.post<ItVendorContractTransitionResult>(`/it/contracts/${id}/transition`, { toStatus }),
  },
};
