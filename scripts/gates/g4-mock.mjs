// G4 (mock scan): the API suite runs against real Postgres, real request
// contexts and the real evaluator. A mock in it proves the mock. CLAUDE.md
// "Never" names this; the scan makes the rule mechanical.
//
// Scope is every file under apps/api/src, tests included, because a mock in a
// helper that a test imports is still a mock in the suite.
import ts from 'typescript';
import { listSources, readSource, parseSource, walk, lineOf, checkRatchet, loadAllowlist } from './lib.mjs';

export const ROOTS = ['apps/api/src'];

// The receivers and methods the gate refuses. Anything else (vi.hoisted, a
// method on some other object named mock) is not a mock of the suite.
const FORBIDDEN = {
  vi: new Set(['mock', 'spyOn', 'fn']),
  jest: new Set(['mock', 'spyOn']),
};

export function scanSource(rel, text) {
  const sf = parseSource(rel, text);
  const findings = [];
  walk(sf, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return;
    const receiver = callee.expression.text;
    const method = callee.name.text;
    if (!FORBIDDEN[receiver]?.has(method)) return;
    const rule = `${receiver}.${method}`;
    findings.push({
      file: rel,
      line: lineOf(sf, node),
      rule,
      message: `${rule}() in the API suite. Tests run against real Postgres and real contexts (CLAUDE.md "Never").`,
    });
  });
  return findings;
}

export function runG4({ root } = {}) {
  const findings = [];
  for (const rel of listSources(ROOTS, { root })) {
    findings.push(...scanSource(rel, readSource(rel, root)));
  }
  const { entries } = loadAllowlist('g4-mock');
  const { problems, baselined, total } = checkRatchet({ gate: 'G4', findings, entries });
  return {
    id: 'G4',
    title: 'mock scan (apps/api/src)',
    problems,
    summary: `${total} mock call(s), ${baselined} baselined`,
  };
}
