/**
 * What a decision may be linked to (SPINE-CONTRACT 1.5; OPUS DECISIONS: a
 * DecisionLink join table, with the type registered here).
 *
 * The list is closed because each entry names a table the domain checks. A new
 * kind is a migration (the CHECK on decision_links.linkType lists these values)
 * and a per-kind existence check in domains/decisions.ts, changed together.
 *
 * `subject` is registered but refused by the domain: a decision's subject is an
 * open string pair (subjectType, subjectId) with no table behind it, so there is
 * nothing to check a link against. It stays in the list so the contract is
 * stated once, and it is refused until a subject registry exists.
 */
export const DECISION_LINK_TYPES = ['task', 'commitment', 'case', 'exception', 'document', 'subject'] as const;

export type DecisionLinkType = (typeof DECISION_LINK_TYPES)[number];

export function isDecisionLinkType(value: string): value is DecisionLinkType {
  return (DECISION_LINK_TYPES as readonly string[]).includes(value);
}
