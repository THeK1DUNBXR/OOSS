/**
 * What a task is about (Wave 6, OP:118; SPINE-CONTRACT 1.4; OPUS decision 6).
 *
 * A task used to name its source with two strings, relatedType and relatedId,
 * which nothing checked. The kind is now one of this closed list. The database
 * holds the same list in a CHECK (migration 20261013130000_task_source_kind), so
 * a new kind is a migration and a change here together, never one without the
 * other. The domain checks that the named row exists in the same tenant.
 *
 * `manual` is the kind for a task no typed row produced: the next action an
 * interaction recorded, or a task a person typed in. It is not a catch-all for
 * a source the registry does not yet know about; that is a new kind.
 */
export const TASK_SOURCE_KINDS = ['commitment', 'case', 'decision', 'exception', 'onboarding_task', 'manual'] as const;

export type TaskSourceKind = (typeof TASK_SOURCE_KINDS)[number];
