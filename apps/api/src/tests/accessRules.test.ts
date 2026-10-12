/**
 * PR11a rules that need no database: who may confirm an assignment (AMP s.7,
 * as decided in P11-DESIGN O7 and O12), the non-employee expiry cap in IST
 * (CLAUDE.md rule 3), and the no-hardcode check on the new domain code
 * (CLAUDE.md "Never"; acceptance.test.ts:364-374 is the pattern).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_SLUGS } from '@kaizen/shared';
import { checkConfirmRules, expiryWithinCap, IDENTITY_TYPES, type ConfirmContext } from '../domains/access/rules.js';

const SUBJECT = 'person-subject';
const ANSWERER = 'person-answerer';
const CONFIRMER = 'person-confirmer';

function ctx(over: Partial<ConfirmContext> = {}): ConfirmContext {
  return {
    subjectPersonId: SUBJECT,
    answererPersonId: ANSWERER,
    confirmerPersonId: CONFIRMER,
    placements: [{ verticalCode: 'V_ONE', reach: 'own' }],
    hasSensitiveDuty: false,
    confirmerReach: { company: false, verticalCodes: ['V_ONE'] },
    ...over,
  };
}

const rulesOf = (c: ConfirmContext) => checkConfirmRules(c).map((v) => v.rule);

describe('checkConfirmRules (AMP s.7; design O7, O12)', () => {
  it('refuses a confirmer who is the person the assignment is for', () => {
    expect(rulesOf(ctx({ confirmerPersonId: SUBJECT }))).toContain('self');
  });

  it('refuses a confirmer who also answered the mapping', () => {
    expect(rulesOf(ctx({ confirmerPersonId: ANSWERER }))).toContain('answerer');
  });

  it('lets the Head of a vertical confirm a staff placement in that vertical', () => {
    expect(rulesOf(ctx())).toEqual([]);
  });

  it('refuses a Head confirming a staff placement in a vertical it does not head', () => {
    const v = checkConfirmRules(ctx({ confirmerReach: { company: false, verticalCodes: ['V_TWO'] } }));
    expect(v).toEqual([{ rule: 'vertical_head_required', verticalCode: 'V_ONE' }]);
  });

  it('refuses a Head confirming a Head placement; the founder confirms those', () => {
    const c = ctx({ placements: [{ verticalCode: 'V_ONE', reach: 'vertical' }] });
    expect(rulesOf(c)).toEqual(['founder_required']);
    expect(rulesOf({ ...c, confirmerReach: { company: true, verticalCodes: [] } })).toEqual([]);
  });

  it('refuses a Head confirming a sensitive duty; the founder confirms it', () => {
    const c = ctx({ hasSensitiveDuty: true });
    expect(rulesOf(c)).toEqual(['founder_required']);
    expect(rulesOf({ ...c, confirmerReach: { company: true, verticalCodes: [] } })).toEqual([]);
  });

  it('lets the founder confirm any staff placement', () => {
    const c = ctx({
      placements: [
        { verticalCode: 'V_ONE', reach: 'own' },
        { verticalCode: 'V_TWO', reach: 'team' },
      ],
      confirmerReach: { company: true, verticalCodes: [] },
    });
    expect(rulesOf(c)).toEqual([]);
  });
});

describe('expiryWithinCap (non-employee, 12 months, IST)', () => {
  const from = new Date('2026-10-12T05:00:00.000Z'); // 10:30 IST, 12 October

  it('needs no expiry for an employee', () => {
    expect(expiryWithinCap('employee', from, null)).toBe(true);
  });

  it('requires an expiry for a non-employee', () => {
    expect(expiryWithinCap('non_employee', from, null)).toBe(false);
  });

  it('accepts an expiry on the last moment of the IST day twelve months out', () => {
    expect(expiryWithinCap('non_employee', from, new Date('2027-10-12T18:29:59.999Z'))).toBe(true);
  });

  it('refuses an expiry one IST day past twelve months', () => {
    expect(expiryWithinCap('non_employee', from, new Date('2027-10-13T18:30:00.000Z'))).toBe(false);
  });

  it('counts the cap in IST: 00:30 IST on 12 October is still the 12th, not the 11th', () => {
    const early = new Date('2026-10-11T19:00:00.000Z');
    expect(expiryWithinCap('non_employee', early, new Date('2027-10-12T18:29:59.999Z'))).toBe(true);
    expect(expiryWithinCap('non_employee', early, new Date('2027-10-12T18:30:00.000Z'))).toBe(false);
  });
});

describe('no hardcode in the access domain (CLAUDE.md rule 4, "Never")', () => {
  const dir = new URL('../domains/access/', import.meta.url);
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(new URL(name, dir), 'utf8') }));

  it('reads the access domain from disk', () => {
    expect(sources.map((s) => s.name)).toEqual(expect.arrayContaining(['rules.ts', 'assignments.ts']));
  });

  it('names no role slug and no business-line code as a literal', () => {
    // 'employee' is both a role slug and an identity type. The identity type is the
    // kind of person, not an authority, so it is not a literal this check forbids.
    const identityWords = IDENTITY_TYPES as readonly string[];
    const forbidden = [
      ...ROLE_SLUGS.filter((slug) => !identityWords.includes(slug)),
      'SKL',
      'EDU',
      'CLR',
      'TEC',
      'WFS',
    ];
    const offenders: string[] = [];
    for (const { name, text } of sources) {
      for (const word of forbidden) {
        if (new RegExp(`['"\`]${word}['"\`]`).test(text)) offenders.push(`${name}: '${word}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
