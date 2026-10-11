/**
 * Every name a lifecycle machine can emit must pass the event grammar. The
 * names are composed at runtime (`platform/lifecycle.ts` builds
 * `kz.<prefix>.<object>.<verb>` from each machine's verb map), so a static
 * scan of `EVENTS` cannot see them; this enumerates the verb maps the
 * transition call sites actually pass.
 */
import { describe, it, expect } from 'vitest';
import {
  EVENTS,
  isCanonicalEventName,
  hrTransitionEvent,
  LEAVE_REQUEST_EVENT_VERB,
  WORK_ATTENDANCE_EVENT_VERB,
  PAYROLL_EVENT_VERB,
  TICKET_EVENT_VERB,
  COMPENSATION_EVENT_VERB,
  POSITION_EVENT_VERB,
  EMPLOYMENT_EVENT_VERB,
  ASSIGNMENT_EVENT_VERB,
  ONBOARDING_EVENT_VERB,
  OFFBOARDING_EVENT_VERB,
  JOB_POSTING_EVENT_VERB,
  OFFER_EVENT_VERB,
  REQUISITION_EVENT_VERB,
  APPLICATION_EVENT_VERB,
  GOAL_EVENT_VERB,
} from '@kaizen/shared';

/** The object segment each `transition({ eventObject })` call site passes, with its verb map. */
const LIFECYCLE_SITES: Array<{ object: string; verbs: Record<string, string>; prefix?: string }> = [
  { object: 'leave', verbs: LEAVE_REQUEST_EVENT_VERB },
  { object: 'work_attendance', verbs: WORK_ATTENDANCE_EVENT_VERB },
  { object: 'payroll_run', verbs: PAYROLL_EVENT_VERB },
  { object: 'ticket', prefix: 'kz.it', verbs: TICKET_EVENT_VERB },
  { object: 'compensation', verbs: COMPENSATION_EVENT_VERB },
  { object: 'position', verbs: POSITION_EVENT_VERB },
  { object: 'employment', verbs: EMPLOYMENT_EVENT_VERB },
  { object: 'assignment', verbs: ASSIGNMENT_EVENT_VERB },
  { object: 'onboarding', verbs: ONBOARDING_EVENT_VERB },
  { object: 'offboarding', verbs: OFFBOARDING_EVENT_VERB },
  { object: 'job_posting', verbs: JOB_POSTING_EVENT_VERB },
  { object: 'offer', verbs: OFFER_EVENT_VERB },
  { object: 'requisition', verbs: REQUISITION_EVENT_VERB },
  { object: 'application', verbs: APPLICATION_EVENT_VERB },
  { object: 'goal', verbs: GOAL_EVENT_VERB },
];

describe('event grammar — every lifecycle name a transition can emit', () => {
  it.each(LIFECYCLE_SITES.map((s) => [s.object, s] as const))('%s: every verb is canonical', (_object, site) => {
    const refused = Object.entries(site.verbs)
      .map(([event, verb]) => ({
        event,
        name: site.prefix ? `${site.prefix}.${site.object}.${verb}` : hrTransitionEvent(site.object, verb),
      }))
      .filter(({ name }) => !isCanonicalEventName(name));
    expect(refused.map((r) => `${r.event} -> ${r.name}`)).toEqual([]);
  });

  it('every static EVENTS name is canonical', () => {
    for (const [key, name] of Object.entries(EVENTS as Record<string, string>)) {
      expect(isCanonicalEventName(name), `EVENTS.${key} = ${name}`).toBe(true);
    }
  });
});
