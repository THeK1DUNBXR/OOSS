// G9 parts 1 (money) and 2 (IST period): ratchet scans over the three source
// roots, tests excluded. Each pattern is counted per file against a checked-in
// baseline; the count may only fall. The draft (docs/plan/zen360/CI-GATES-DRAFT.md,
// G9) states these as lint rules. They are built as scans instead because a lint
// error on today's code would block on about 1,800 existing money sites with no
// per-file allowance; the ratchet keeps those sites and refuses new ones.
//
// Money (CLAUDE.md rule 1): round2(, Math.round(, Number.EPSILON, num(, Number(
//   The draft says "on money-typed values". A scan cannot see types, so it
//   counts every call. That over-counts on purpose: the baseline shrinks as
//   sites are converted, and a non-money conversion is a line nobody needs.
// IST (CLAUDE.md rule 3): .getUTCMonth(), .getUTCFullYear(), .getUTCDate()
//   packages/shared/src/time.ts is the one place these may appear.
import ts from 'typescript';
import { listSources, readSource, parseSource, walk, lineOf, checkRatchet, loadAllowlist } from './lib.mjs';

export const ROOTS = ['apps/api/src', 'packages/shared/src', 'apps/web/src'];
export const IST_EXEMPT = new Set(['packages/shared/src/time.ts']);

export const MONEY_RULES = ['round2(', 'Math.round(', 'Number.EPSILON', 'num(', 'Number('];
export const IST_RULES = ['.getUTCMonth()', '.getUTCFullYear()', '.getUTCDate()'];

const MONEY_MESSAGE = {
  'round2(': 'round2() on a value that may be money. Money is bigint paise (CLAUDE.md rule 1).',
  'Math.round(':
    'Math.round() on a value that may be money. Money is bigint paise, not rounded floats (CLAUDE.md rule 1).',
  'Number.EPSILON': 'Number.EPSILON is a float comparison. Money is bigint paise; compare with ===.',
  'num(': 'num() reads a money value through a float (FX-31). Money is bigint paise (CLAUDE.md rule 1).',
  'Number(': 'Number() conversion that may read money through a float. Money is bigint paise (CLAUDE.md rule 1).',
};

const IST_MESSAGE =
  'UTC getter in a period path. Financial year, tax period and series are IST (CLAUDE.md rule 3); use packages/shared/src/time.ts.';

export function scanSource(rel, text) {
  const sf = parseSource(rel, text);
  const exemptIst = IST_EXEMPT.has(rel);
  const findings = [];
  const add = (node, rule, message) => findings.push({ file: rel, line: lineOf(sf, node), rule, message });

  walk(sf, (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        if (callee.text === 'round2') add(node, 'round2(', MONEY_MESSAGE['round2(']);
        else if (callee.text === 'num') add(node, 'num(', MONEY_MESSAGE['num(']);
        else if (callee.text === 'Number') add(node, 'Number(', MONEY_MESSAGE['Number(']);
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const obj = callee.expression.text;
        const method = callee.name.text;
        if (obj === 'Math' && method === 'round') add(node, 'Math.round(', MONEY_MESSAGE['Math.round(']);
        if (!exemptIst && IST_RULES.includes(`.${method}()`)) add(node, `.${method}()`, IST_MESSAGE);
      }
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Number' &&
      node.name.text === 'EPSILON'
    ) {
      add(node, 'Number.EPSILON', MONEY_MESSAGE['Number.EPSILON']);
    }
  });
  return findings;
}

function collect(root, rules) {
  const findings = [];
  for (const rel of listSources(ROOTS, { root })) {
    findings.push(...scanSource(rel, readSource(rel, root)).filter((f) => rules.includes(f.rule)));
  }
  return findings;
}

export function collectMoney({ root } = {}) {
  return collect(root, MONEY_RULES);
}

export function collectIst({ root } = {}) {
  return collect(root, IST_RULES);
}

export function runG9({ root } = {}) {
  const out = [];
  for (const [id, title, name, findings] of [
    ['G9 money', 'money patterns (ratchet)', 'g9-money', collectMoney({ root })],
    ['G9 IST', 'IST period patterns (ratchet)', 'g9-ist', collectIst({ root })],
  ]) {
    const { entries } = loadAllowlist(name);
    const { problems, baselined, total } = checkRatchet({ gate: id, findings, entries });
    out.push({ id, title, problems, summary: `${total} hit(s), ${baselined} baselined` });
  }
  return out;
}
