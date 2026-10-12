// G10 check (c)(1), approval by role: a ratchet over string literals that name a
// role label or a holder's email. The statutory approver is resolved at runtime
// from a tenant duty (STATUTORY_APPROVER_DUTY, domains/statutory.ts), so no code
// outside the seed folder may name the person or the role that holds it.
// Structure only: this gate never reads a statutory value (round 27 c).
//
// Scope is the finance, HCM and compliance paths under the roots below, plus the
// shared package. The seed folder (the one place labels may be written, as seed
// data) and test files are excluded. Matching is on AST string literals, so a
// comment never produces a hit, and a module specifier never does either.
//
// Labels match case-insensitively as whole words: a display label such as
// "Accountant" is a hit on purpose (it is the inventory's category (b)), and
// "accountants" or "chairman_id" are not.
import ts from 'typescript';
import { listSources, readSource, parseSource, walk, lineOf, checkRatchet, loadAllowlist, isTestFile } from './lib.mjs';

export const ROOTS = [
  'apps/api/src/domains',
  'apps/api/src/routes',
  'apps/api/src/platform',
  'apps/api/src/jobs',
  'packages/shared/src',
];
export const SEED_PREFIX = 'apps/api/src/seed/';
export const ROLE_LABELS = ['finance_head', 'accountant', 'chairman', 'internal finance head'];
export const EMAIL_RULE = '@kaizen.co.in';
export const G10_RULES = [...ROLE_LABELS, EMAIL_RULE];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PATTERNS = new Map([
  ...ROLE_LABELS.map((label) => [label, new RegExp(`(?<![A-Za-z0-9_])${escapeRe(label)}(?![A-Za-z0-9_])`, 'i')]),
  [EMAIL_RULE, /@kaizen\.co\.in\b/i],
]);

const MESSAGE = (rule) =>
  rule === EMAIL_RULE
    ? 'Holder email literal in code. The approver is resolved from the tenant duty, not named here (G10 c(1)).'
    : `Role label "${rule}" in code. The approver is resolved from the tenant duty, not named here (G10 c(1)).`;

// Only paths the gate judges. Used by the collector and by the tests, so the
// exclusion is one function, not a list of roots that happens to leave seeds out.
export function inScope(rel) {
  return !rel.startsWith(SEED_PREFIX) && !isTestFile(rel);
}

function isLiteral(node) {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

// A module path such as './accountant.js' names a file, not a role.
function isModuleSpecifier(node) {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === node) return true;
  if (ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) && p.parent && ts.isImportTypeNode(p.parent)) return true;
  if (ts.isCallExpression(p) && p.arguments[0] === node) {
    const callee = p.expression;
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(callee) && callee.text === 'require') return true;
  }
  return false;
}

// One finding per rule a literal matches. A literal that names two labels is two
// findings, because each is a separate holder decision to convert.
export function scanSource(rel, text) {
  const sf = parseSource(rel, text);
  const findings = [];
  walk(sf, (node) => {
    if (!isLiteral(node) || isModuleSpecifier(node)) return;
    for (const [rule, re] of PATTERNS) {
      if (re.test(node.text)) findings.push({ file: rel, line: lineOf(sf, node), rule, message: MESSAGE(rule) });
    }
  });
  return findings;
}

export function collectRoles({ root } = {}) {
  const findings = [];
  for (const rel of listSources(ROOTS, { root }).filter(inScope)) {
    findings.push(...scanSource(rel, readSource(rel, root)));
  }
  return findings;
}

// The ratchet is lib's checkRatchet, unchanged. Its stale-entry messages are
// moved from problems to notes here: a count that fell passes, and the note says
// the baseline can be lowered. A rising count still fails.
export function checkRoles({ findings, entries, gate = 'G10 roles' }) {
  const { problems: all, baselined, total } = checkRatchet({ gate, findings, entries });
  const isStale = (p) => p.includes(' stale entry: ');
  return {
    problems: all.filter((p) => !isStale(p)),
    notes: all.filter(isStale),
    baselined,
    total,
  };
}

export function runG10({ root } = {}) {
  const { entries } = loadAllowlist('g10-roles');
  const { problems, notes, baselined, total } = checkRoles({ findings: collectRoles({ root }), entries });
  return {
    id: 'G10 roles',
    title: 'role labels and holder emails in finance, HCM, compliance and shared code (ratchet)',
    problems,
    notes,
    summary: `${total} hit(s), ${baselined} baselined`,
  };
}
