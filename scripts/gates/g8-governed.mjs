// G8(a) (governed-write scan): CLAUDE.md rule 5, every write is
// assertCan -> write -> auditWrite -> emit. This is the static half. The
// runtime half (one audit row per governed entity) is a separate test and is
// not part of this gate.
//
// What it refuses:
//   - an auditWrite whose literal subjectType no production
//     registerGovernedEntities(domain, [...]) call names. auditWrite refuses
//     that subject at runtime (platform/audit.ts, isGoverned);
//   - force: true anywhere in an auditWrite argument (no bypass of registration);
//   - within one function body, an emit( before the first auditWrite(;
//   - within one function body, an auditWrite( before the first assertCan(.
//
// Calls are attributed to their innermost function, so a transaction callback
// is ordered on its own, not against the function that opens it. A subjectType
// this scan cannot read is counted, not failed: it is a heuristic, and the
// count tells the reader how much of the registry it could not see.
import ts from 'typescript';
import {
  listSources,
  readSource,
  parseSource,
  walk,
  lineOf,
  isTestFile,
  isFunctionScope,
  calledName,
  checkRatchet,
  loadAllowlist,
} from './lib.mjs';

export const ROOTS = ['apps/api/src'];

const isStringish = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

function propName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

// A top-level `const NAME = 'literal'` in the same file, so a subjectType held
// in a named constant is still read. Shadowing and imports are not followed.
function stringConstants(sf) {
  const out = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer && isStringish(decl.initializer)) {
        out.set(decl.name.text, decl.initializer.text);
      }
    }
  }
  return out;
}

function resolveString(expr, consts) {
  if (!expr) return null;
  if (isStringish(expr)) return expr.text;
  if (ts.isIdentifier(expr) && consts.has(expr.text)) return consts.get(expr.text);
  return null;
}

// The literal subjectType of an auditWrite call, or null when it cannot be read.
function subjectTypeOf(call, consts) {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const p of arg.properties) {
    if (ts.isPropertyAssignment(p) && propName(p.name) === 'subjectType') {
      return resolveString(p.initializer, consts);
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'subjectType') {
      return resolveString(p.name, consts);
    }
  }
  return null;
}

function forceTrueNodes(call) {
  const hits = [];
  for (const arg of call.arguments) {
    walk(arg, (n) => {
      if (
        ts.isPropertyAssignment(n) &&
        propName(n.name) === 'force' &&
        n.initializer.kind === ts.SyntaxKind.TrueKeyword
      ) {
        hits.push(n);
      }
    });
  }
  return hits;
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return '<anonymous>';
}

export function analyzeGoverned(sourceMap) {
  const files = Object.keys(sourceMap)
    .filter((f) => !isTestFile(f))
    .sort();
  const parsed = files.map((file) => ({ file, sf: parseSource(file, sourceMap[file]) }));

  const registered = new Set();
  for (const { sf } of parsed) {
    walk(sf, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      if (node.expression.text !== 'registerGovernedEntities') return;
      const list = node.arguments[1];
      if (!list || !ts.isArrayLiteralExpression(list)) return;
      for (const el of list.elements) if (isStringish(el)) registered.add(el.text);
    });
  }

  const findings = [];
  let unresolved = 0;
  let auditWrites = 0;

  for (const { file, sf } of parsed) {
    const consts = stringConstants(sf);
    // One group per function body, keyed by the function node. Calls outside
    // any function are grouped under the source file itself.
    const groups = new Map();
    const groupFor = (scope) => {
      if (!groups.has(scope))
        groups.set(scope, {
          name: isFunctionScope(scope) ? functionName(scope) : '<module>',
          audits: [],
          emits: [],
          asserts: [],
        });
      return groups.get(scope);
    };

    const visit = (node, scope) => {
      const inner = isFunctionScope(node) ? node : scope;
      if (ts.isCallExpression(node)) {
        const name = calledName(node);
        if (name === 'auditWrite') {
          auditWrites += 1;
          groupFor(inner).audits.push(node);
          for (const p of forceTrueNodes(node)) {
            findings.push({
              file,
              line: lineOf(sf, p),
              rule: 'force-true',
              message:
                'force: true in an auditWrite argument. Registration is the only way past auditWrite; do not bypass it.',
            });
          }
          const subject = subjectTypeOf(node, consts);
          if (subject === null) {
            unresolved += 1;
          } else if (!registered.has(subject)) {
            findings.push({
              file,
              line: lineOf(sf, node),
              rule: 'unregistered-subjectType',
              message: `auditWrite subjectType '${subject}' is not named by any registerGovernedEntities call; auditWrite refuses it at runtime.`,
            });
          }
        } else if (name === 'emit') {
          groupFor(inner).emits.push(node);
        } else if (name === 'assertCan') {
          groupFor(inner).asserts.push(node);
        }
      }
      ts.forEachChild(node, (child) => visit(child, inner));
    };
    visit(sf, sf);

    for (const g of groups.values()) {
      if (g.audits.length === 0) continue;
      const firstAudit = g.audits.reduce((a, b) => (a.getStart(sf) <= b.getStart(sf) ? a : b));
      if (g.emits.length > 0) {
        const firstEmit = g.emits.reduce((a, b) => (a.getStart(sf) <= b.getStart(sf) ? a : b));
        if (firstEmit.getStart(sf) < firstAudit.getStart(sf)) {
          findings.push({
            file,
            line: lineOf(sf, firstEmit),
            rule: 'emit-before-auditWrite',
            message: `emit() runs before auditWrite() (line ${lineOf(sf, firstAudit)}) in ${g.name}. CLAUDE.md rule 5 orders auditWrite, then emit.`,
          });
        }
      }
      if (g.asserts.length > 0) {
        const firstAssert = g.asserts.reduce((a, b) => (a.getStart(sf) <= b.getStart(sf) ? a : b));
        if (firstAudit.getStart(sf) < firstAssert.getStart(sf)) {
          findings.push({
            file,
            line: lineOf(sf, firstAudit),
            rule: 'auditWrite-before-assertCan',
            message: `auditWrite() runs before assertCan() (line ${lineOf(sf, firstAssert)}) in ${g.name}. CLAUDE.md rule 5 orders assertCan first.`,
          });
        }
      }
    }
  }

  return { findings, unresolved, auditWrites, registered };
}

export function collectG8({ root } = {}) {
  const sourceMap = {};
  for (const rel of listSources(ROOTS, { root })) sourceMap[rel] = readSource(rel, root);
  return analyzeGoverned(sourceMap);
}

export function runG8({ root } = {}) {
  const { findings, unresolved, auditWrites, registered } = collectG8({ root });
  const { entries } = loadAllowlist('g8-governed');
  const { problems, baselined } = checkRatchet({ gate: 'G8', findings, entries });
  return {
    id: 'G8',
    title: 'governed writes (static, apps/api/src)',
    problems,
    summary:
      `${auditWrites} auditWrite call(s), ${registered.size} registered subjectTypes; ` +
      `${unresolved} subjectType not a literal (counted, not failed); ${baselined} order finding(s) baselined`,
  };
}
