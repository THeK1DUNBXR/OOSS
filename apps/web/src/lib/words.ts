/**
 * The plain-language layer.
 *
 * The platform's internal vocabulary is precise and worth keeping — `H_FIN`,
 * `S3_HIGH_RISK`, `own_or_unowned` and `EX-CRM-014` all mean something exact,
 * and the governance and audit surfaces need exactly that precision.
 *
 * But a counsellor in Madurai opening this on a Tuesday is not reading a
 * specification. So the rule across the product is:
 *
 *   plain words lead, the code stays available.
 *
 * Nothing is hidden and nothing is renamed in the database. A screen says
 * "High risk" where it used to say "S3_HIGH_RISK", and the code is still
 * there — in the tooltip, in the audit trail, in the API response — for the
 * person whose job needs it.
 */

// ---------------------------------------------------------------------------
// Health domains
// ---------------------------------------------------------------------------

/** What the domain is called, and what it is actually telling you. */
export const DOMAIN_WORDS: Record<string, { name: string; asks: string }> = {
  H_FIN: { name: 'Money', asks: 'Are we getting paid for the work we have done?' },
  H_COM: { name: 'Sales', asks: 'Is there enough in the pipeline to hit the number?' },
  H_DLV: { name: 'Delivery', asks: 'Is the work we sold actually being delivered?' },
  H_EDU: { name: 'Training', asks: 'Are learners finishing what they started?' },
  H_PPL: { name: 'People', asks: 'Is the team staffed and steady?' },
  H_MKT: { name: 'Marketing', asks: 'Is enough new interest coming in?' },
  H_CUS: { name: 'Customers', asks: 'Are the people we already serve staying happy?' },
  H_OPS: { name: 'Operations', asks: 'Is the day-to-day running cleanly?' },
  H_STR: { name: 'Strategy', asks: 'Are the long bets moving?' },
  H_RSK: { name: 'Risk', asks: 'Are the problems we know about being handled?' },
  H_TEC: { name: 'Technology', asks: 'Are the systems we run on being looked after?' },
};

export function domainName(code: string, fallback?: string | null): string {
  return DOMAIN_WORDS[code]?.name ?? fallback ?? code;
}

export function domainAsks(code: string): string | null {
  return DOMAIN_WORDS[code]?.asks ?? null;
}

// ---------------------------------------------------------------------------
// How healthy, and how urgent
// ---------------------------------------------------------------------------

export const BAND_WORDS: Record<string, string> = {
  strong: 'Good',
  watch: 'Keep an eye on it',
  strained: 'Slipping',
  critical: 'Needs action now',
};

/** Said of a score with too little evidence behind it to be worth stating. */
export const NOT_MEASURED = 'Nothing to measure yet';

export const SEVERITY_WORDS: Record<string, string> = {
  S0_INFO: 'For information',
  S1_ATTENTION: 'Worth a look',
  S2_WARNING: 'Needs attention',
  S3_HIGH_RISK: 'High risk',
  S4_CRITICAL: 'Urgent',
};

export function severityWord(code: string | null | undefined): string {
  if (!code) return '';
  return SEVERITY_WORDS[code] ?? code.replace(/^S\d_/, '').replace(/_/g, ' ').toLowerCase();
}

/** How loudly to tell someone — deliberately separate from how bad it is. */
export const PRIORITY_WORDS: Record<string, string> = {
  N0_SILENT: 'Recorded quietly',
  N1_DIGEST: 'In your daily summary',
  N2_NOTIFY: 'Notified',
  N3_ALERT: 'Alerted',
  N4_INTERRUPT: 'Interrupts you',
};

// ---------------------------------------------------------------------------
// Permissions, said out loud
// ---------------------------------------------------------------------------

export const VERB_WORDS: Record<string, string> = {
  view: 'see',
  create: 'add',
  edit: 'change',
  delete: 'remove',
  assign: 'assign to someone',
  export: 'export',
  financial: 'see money figures',
  approve: 'approve',
  merge: 'merge duplicates',
};

export const SCOPE_WORDS: Record<string, string> = {
  all: 'anyone’s records',
  own: 'only their own records',
  own_or_unowned: 'their own, plus anything unclaimed in their branch',
};

export const SCOPE_RESOLVER_WORDS: Record<string, string> = {
  batch_member: 'limited to the batches they teach',
  management_chain: 'plus the team they supervise',
};

/** Turns `view,create,edit@own` into a sentence a person can check. */
export function grantSentence(verbs: string[], scope: string, resolver?: string | null): string {
  const said = verbs.map((v) => VERB_WORDS[v] ?? v);
  const list =
    said.length <= 1
      ? (said[0] ?? 'do nothing')
      : `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}`;
  const where = SCOPE_WORDS[scope] ?? scope;
  const extra = resolver ? `, ${SCOPE_RESOLVER_WORDS[resolver] ?? resolver}` : '';
  return `Can ${list} — ${where}${extra}.`;
}

// ---------------------------------------------------------------------------
// Sensitivity and withholding
// ---------------------------------------------------------------------------

export const SENSITIVITY_WORDS: Record<string, string> = {
  public: 'Public',
  internal: 'Staff only',
  restricted: 'Restricted',
  confidential: 'Confidential',
  regulated: 'Legally protected',
};

export const WITHHELD_WORDS: Record<string, string> = {
  no_permission: 'You do not have access to this field',
  classification_ceiling: 'This is above your access level',
  consent_missing: 'The person has not consented to this being shared',
  purpose_mismatch: 'Not available for the reason you are viewing this',
  legal_hold: 'Held for legal reasons',
};

export function withheldWord(reason: string): string {
  return WITHHELD_WORDS[reason] ?? reason.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Forecasting
// ---------------------------------------------------------------------------

export const FORECAST_METHOD_WORDS: Record<string, string> = {
  weighted_stage: 'Weighted by how far along each deal is',
  manual_commit: 'Only deals someone has personally committed to',
  milestone_based: 'Counted as each milestone is reached',
};

export const FORECAST_CATEGORY_WORDS: Record<string, string> = {
  omitted: 'Not counted',
  pipeline: 'In the pipeline',
  best_case: 'Best case',
  commit: 'Committed',
  closed_won: 'Won',
  closed_lost: 'Lost',
};

// ---------------------------------------------------------------------------
// Why a lead has no owner
// ---------------------------------------------------------------------------

export const UNROUTED_WORDS: Record<string, string> = {
  no_matching_rule:
    'No routing rule covers this combination yet — someone needs to add one, or assign this by hand.',
  no_eligible_candidate:
    'A rule matched, but nobody suitable is free. Assign it by hand.',
};

export function unroutedWord(code: string | null | undefined): string {
  if (!code) return '';
  return UNROUTED_WORDS[code] ?? words(code);
}

// ---------------------------------------------------------------------------
// Money and dates, in words rather than notation
// ---------------------------------------------------------------------------

/** "in 3 days" / "6 days ago" / "today" — never a raw ISO string. */
export function whenWord(date: string | Date | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return days < 30 ? `in ${days} days` : `in ${Math.round(days / 30)} months`;
  const ago = Math.abs(days);
  return ago < 30 ? `${ago} days ago` : `${Math.round(ago / 30)} months ago`;
}

/** Turns a snake_case value from the API into ordinary words. */
export function words(value: string | null | undefined): string {
  if (!value) return '';
  const s = value.replace(/_/g, ' ').trim();
  const sentence = s.charAt(0).toUpperCase() + s.slice(1);
  // Terms the business writes a particular way, which sentence-casing breaks.
  return sentence.replace(/\bMou\b/g, 'MoU').replace(/\bSla\b/g, 'SLA').replace(/\bAi\b/g, 'AI');
}

/**
 * Turns a raw identifier — `snake_case`, `PascalCase` or `camelCase` — into a
 * plain sentence, whatever shape the record's lifecycle machine or schema
 * happens to write it in. `PendingHire` and `pending_hire` both come out
 * "Pending hire"; a run of capitals (an acronym such as `FF` in
 * `FFSettlementPending`) is left alone rather than broken up letter by letter.
 *
 * This is the one to reach for on a raw slug straight off the wire — a status,
 * a reason code, a field name — where nothing more specific applies.
 */
export function humanize(value: string | null | undefined): string {
  if (!value) return '';
  const spaced = value
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
  if (!spaced) return '';
  const sentence = spaced
    .split(/\s+/)
    .map((w, i) => {
      if (/^[A-Z]{2,}$/.test(w)) return w; // an acronym — leave it be
      const lower = w.toLowerCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
  return sentence.replace(/\bMou\b/g, 'MoU').replace(/\bSla\b/g, 'SLA').replace(/\bAi\b/g, 'AI');
}
