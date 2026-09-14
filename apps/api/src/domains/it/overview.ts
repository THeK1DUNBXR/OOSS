/**
 * Technology — overview (docs/plan/cio.md, workstream I).
 *
 * One call that composes every workstream's own summary into a KPI wall.
 * This module never computes a figure of its own — every number here is
 * exactly what the workstream's `/<segment>/summary` endpoint already
 * returned, gathered so a single request can render the Command Center
 * tile wall server-side (the web page itself reads each workstream's
 * summary endpoint directly and does not call this one, per its own
 * header comment — this endpoint exists for API consumers that want one
 * round trip).
 *
 * A section a caller lacks the grant to view is reported as
 * `{ withheld: true }` rather than surfacing the 403 — a Finance Head still
 * sees the whole wall, just with the sections their role does not carry
 * blanked out instead of the whole request failing. A workstream with no
 * rows yet reports `{ notYetMeasured: true, ... }`, exactly as its own
 * summary does — this module never turns that into a zero.
 */

import { ApiError } from '../../platform/errors.js';
import { summary as assetsSummary } from './assets.js';
import { applicationsSummary, licencesSummary } from './software.js';
import { summaryVendors, summaryContracts } from './vendors.js';
import { summary as ticketsSummary } from './servicedesk.js';
import { incidentSummary, changeSummary } from './itsm.js';
import { risksSummary, findingsSummary, policiesSummary } from './governance.js';
import { portfolioSummary, budgetSummary } from './portfolio.js';
import { continuitySummary, availabilitySummary } from './continuity.js';

/** A withheld tile: the caller's role does not carry `view` on that
 * resource, so the section is blanked out rather than failing the whole
 * request. */
export interface Withheld {
  withheld: true;
}

/** Each workstream's summary function returns its own named interface
 * (`ApplicationsSummary`, `ItBudgetSummary`, ...), none of them carrying a
 * string index signature. This module composes fifteen different such
 * shapes into one JSON object without caring about any one of their exact
 * fields, so every section is read back as a plain object here — callers
 * that care about a specific section's fields import that workstream's own
 * summary type. */
type Section = Record<string, unknown>;

/** Every summary call goes through this: a 403 becomes a withheld tile
 * instead of a failed request. Any other error is a real defect and
 * propagates. */
async function section<T extends object>(fn: () => Promise<T>): Promise<Section | Withheld> {
  try {
    const result = await fn();
    return result as unknown as Section;
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      return { withheld: true };
    }
    throw err;
  }
}

function isNotYetMeasuredOrWithheld(s: Section | Withheld): boolean {
  return (s as { notYetMeasured?: boolean }).notYetMeasured === true || (s as { withheld?: boolean }).withheld === true;
}

export interface TechnologyOverview {
  notYetMeasured: boolean;
  assets: Section | Withheld;
  applications: Section | Withheld;
  licences: Section | Withheld;
  vendors: Section | Withheld;
  contracts: Section | Withheld;
  tickets: Section | Withheld;
  incidents: Section | Withheld;
  changes: Section | Withheld;
  risks: Section | Withheld;
  findings: Section | Withheld;
  policies: Section | Withheld;
  initiatives: Section | Withheld;
  budget: Section | Withheld;
  continuity: Section | Withheld;
  availability: Section | Withheld;
}

export async function overview(): Promise<TechnologyOverview> {
  const [
    assets,
    applications,
    licences,
    vendors,
    contracts,
    tickets,
    incidents,
    changes,
    risks,
    findings,
    policies,
    initiatives,
    budget,
    continuity,
    availability,
  ] = await Promise.all([
    section(() => assetsSummary()),
    section(() => applicationsSummary()),
    section(() => licencesSummary()),
    section(() => summaryVendors()),
    section(() => summaryContracts()),
    section(() => ticketsSummary()),
    section(() => incidentSummary()),
    section(() => changeSummary()),
    section(() => risksSummary()),
    section(() => findingsSummary()),
    section(() => policiesSummary()),
    section(() => portfolioSummary()),
    section(() => budgetSummary()),
    section(() => continuitySummary()),
    section(() => availabilitySummary()),
  ]);

  // Not yet measured overall only when every section is either unmeasured or
  // withheld — never when a mix of measured sections happens to include one
  // with a zero-looking figure.
  const notYetMeasured = [
    assets,
    applications,
    licences,
    vendors,
    contracts,
    tickets,
    incidents,
    changes,
    risks,
    findings,
    policies,
    initiatives,
    budget,
    continuity,
    availability,
  ].every(isNotYetMeasuredOrWithheld);

  return {
    notYetMeasured,
    assets,
    applications,
    licences,
    vendors,
    contracts,
    tickets,
    incidents,
    changes,
    risks,
    findings,
    policies,
    initiatives,
    budget,
    continuity,
    availability,
  };
}
