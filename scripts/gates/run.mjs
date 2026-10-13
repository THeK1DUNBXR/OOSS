#!/usr/bin/env node
// Runs every static gate and exits non-zero if any fails. Each failure line
// names file:line and the rule. Baselines are ratchets: `--write-baseline`
// regenerates the ratchet entries from the current code (review the diff; a
// count that rises is a new violation, not a baseline update).
import { runG4 } from './g4-mock.mjs';
import { runG8, collectG8 } from './g8-governed.mjs';
import { runG9, collectMoney, collectIst, MONEY_RULES, IST_RULES } from './g9-ratchet.mjs';
import { runG10, collectRoles, G10_RULES } from './g10-roles.mjs';
import { runG13, writeG13Baseline } from './g13-audit.mjs';
import { writeAllowlist } from './lib.mjs';

const ORDER_RULES = ['emit-before-auditWrite', 'auditWrite-before-assertCan'];

if (process.argv.includes('--write-baseline')) {
  const paths = [
    writeAllowlist('g9-money', {
      gate: 'G9 money',
      description:
        'Ratchet for CLAUDE.md rule 1 (money is bigint paise). Per-file counts; a count may only fall. Regenerate with node scripts/gates/run.mjs --write-baseline.',
      findings: collectMoney(),
      managedRules: MONEY_RULES,
      defaultReason:
        'Baselined at Wave 7 (W7-A). Convert this site to bigint paise through the 1.6 money helper (FX-31); do not raise the count.',
    }),
    writeAllowlist('g9-ist', {
      gate: 'G9 IST',
      description:
        'Ratchet for CLAUDE.md rule 3 (periods are IST). Per-file counts; a count may only fall. packages/shared/src/time.ts is exempt. Regenerate with node scripts/gates/run.mjs --write-baseline.',
      findings: collectIst(),
      managedRules: IST_RULES,
      defaultReason:
        'Baselined at Wave 7 (W7-A). Derive this period through packages/shared/src/time.ts (FX-40, FX-41); do not raise the count.',
    }),
    writeAllowlist('g10-roles', {
      gate: 'G10 roles',
      description:
        'Ratchet for G10 check (c)(1): no role label or holder email literal in finance, HCM, compliance or shared code. The approver is resolved from a tenant duty. Per-file counts; a count may only fall. Regenerate with node scripts/gates/run.mjs --write-baseline.',
      findings: collectRoles(),
      managedRules: G10_RULES,
      defaultReason: 'Baselined at G10 (round 27 c). Resolve this approver from a tenant duty; do not raise the count.',
    }),
    writeG13Baseline(),
    writeAllowlist('g8-governed', {
      gate: 'G8',
      description:
        'Order findings for CLAUDE.md rule 5 (assertCan, then auditWrite, then emit). Unregistered subjectTypes and force: true have no entries and must not get one. Regenerate with node scripts/gates/run.mjs --write-baseline.',
      findings: collectG8().findings,
      managedRules: ORDER_RULES,
      defaultReason:
        'Baselined at Wave 7 (W7-A). This function does not yet run the rule 5 order; fix the order and drop this entry.',
    }),
  ];
  for (const p of paths) console.log(`wrote ${p}`);
  process.exit(0);
}

const results = [runG4(), runG8(), ...runG9(), runG10(), runG13()];
let failures = 0;
for (const r of results) {
  const status = r.problems.length === 0 ? 'ok' : 'FAIL';
  console.log(`${r.id} ${r.title}: ${status}. ${r.summary}`);
  for (const p of r.problems) console.log(`  ${p}`);
  // Notes are not failures. A count that fell below its baseline is reported here so
  // the baseline gets lowered; until then a count can rise back to the old cap.
  for (const n of r.notes ?? []) console.log(`  note: ${n}`);
  failures += r.problems.length;
}

if (failures > 0) {
  console.error(`\n${failures} static gate problem(s). See the lines above.`);
  process.exit(1);
}
console.log('\nAll static gates pass.');
