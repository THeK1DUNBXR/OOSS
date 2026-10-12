// Shared machinery for the static gates. Every scan parses source with the
// TypeScript compiler API, so a comment or a string cannot trigger a finding,
// and every baseline is a ratchet: it may shrink, and it fails when it no
// longer matches the code.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const GATES_DIR = dirname(fileURLToPath(import.meta.url));
export const ALLOWLIST_DIR = join(GATES_DIR, 'allowlist');
export const REPO_ROOT = resolve(GATES_DIR, '..', '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

// A test file is one the production gates ignore. Tests are exempt from the
// governed-write, money and period rules because they build fixtures on purpose.
export function isTestFile(rel) {
  return /(^|\/)(tests?|__tests__)\//.test(rel) || /\.(test|spec)\.(ts|tsx|mjs|js)$/.test(rel);
}

// Lists source files under the given repo-relative roots, as posix paths.
export function listSources(roots, { root = REPO_ROOT } = {}) {
  const out = [];
  const walkDir = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const childAbs = join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walkDir(childAbs, childRel);
      else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(childRel);
    }
  };
  for (const r of roots) {
    const abs = join(root, r);
    if (existsSync(abs)) walkDir(abs, r);
  }
  return out.sort();
}

export function readSource(rel, root = REPO_ROOT) {
  return readFileSync(join(root, rel), 'utf8');
}

export function parseSource(rel, text) {
  const kind = extname(rel) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
}

export function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

export function isFunctionScope(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

// The name of a call made as `name(...)` or as `x.name(...)`.
export function calledName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

const keyOf = (file, rule) => `${file}\u0000${rule}`;

// Checks entries of the form { file, rule, count, reason }. A reason is what
// makes an entry reviewable, and a count of zero or less is an entry that
// asserts nothing, so both are refused.
export function validateEntries(entries) {
  const problems = [];
  entries.forEach((e, i) => {
    const where = `entry ${i + 1} (${e?.file ?? '?'} ${e?.rule ?? '?'})`;
    if (typeof e?.file !== 'string' || !e.file) problems.push(`${where}: no file`);
    if (typeof e?.rule !== 'string' || !e.rule) problems.push(`${where}: no rule`);
    if (!Number.isInteger(e?.count) || e.count <= 0) problems.push(`${where}: count must be a positive integer`);
    if (typeof e?.reason !== 'string' || e.reason.trim() === '') problems.push(`${where}: every entry needs a reason`);
  });
  return problems;
}

// The ratchet. `findings` are everything the scan saw, `entries` the checked-in
// baseline. A file-and-rule pair may have up to `count` hits; more is a new
// hit and fails, fewer is a stale entry and fails, so the list can only shrink.
export function checkRatchet({ gate, findings, entries }) {
  const problems = validateEntries(entries).map((p) => `${gate}: ${p}`);
  const allowed = new Map();
  for (const e of entries) {
    if (typeof e?.file === 'string' && typeof e?.rule === 'string' && Number.isInteger(e.count) && e.count > 0) {
      allowed.set(keyOf(e.file, e.rule), e);
    }
  }

  const byKey = new Map();
  for (const f of findings) {
    const k = keyOf(f.file, f.rule);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(f);
  }

  let baselined = 0;
  for (const [k, list] of byKey) {
    const entry = allowed.get(k);
    const cap = entry ? entry.count : 0;
    if (list.length > cap) {
      for (const f of list) {
        const note = cap > 0 ? ` [baseline allows ${cap}, found ${list.length}]` : '';
        problems.push(`${gate} ${f.file}:${f.line} ${f.rule}: ${f.message}${note}`);
      }
    } else {
      baselined += list.length;
    }
  }

  for (const [k, entry] of allowed) {
    const found = byKey.get(k)?.length ?? 0;
    if (found < entry.count) {
      problems.push(
        `${gate} stale entry: ${entry.file} ${entry.rule} allows ${entry.count} but ${found} found. ` +
          `Lower the count (or remove the entry) in the allowlist.`,
      );
    }
  }

  return { problems, baselined, total: findings.length };
}

export function loadAllowlist(name) {
  const path = join(ALLOWLIST_DIR, `${name}.json`);
  if (!existsSync(path)) return { entries: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Regenerates the entries for the rules this gate manages from the scan. A
// reason already written for the same file and rule survives; a new entry gets
// the default reason, which says why it exists. Entries for other rules (for
// example a zero-tolerance rule kept by hand) are left as they are.
export function writeAllowlist(name, { gate, description, findings, defaultReason, managedRules }) {
  const previous = loadAllowlist(name).entries;
  const reasons = new Map(previous.map((e) => [keyOf(e.file, e.rule), e.reason]));
  const counts = new Map();
  for (const f of findings.filter((x) => managedRules.includes(x.rule))) {
    const k = keyOf(f.file, f.rule);
    const prior = counts.get(k);
    counts.set(k, { file: f.file, rule: f.rule, count: (prior?.count ?? 0) + 1 });
  }
  const regenerated = [...counts.values()].map((e) => ({
    ...e,
    reason: reasons.get(keyOf(e.file, e.rule)) ?? defaultReason,
  }));
  const kept = previous.filter((e) => !managedRules.includes(e.rule));
  const all = [...kept, ...regenerated].sort((a, b) =>
    a.file === b.file ? a.rule.localeCompare(b.rule) : a.file.localeCompare(b.file),
  );
  const path = join(ALLOWLIST_DIR, `${name}.json`);
  writeFileSync(path, `${JSON.stringify({ gate, description, entries: all }, null, 2)}\n`);
  return path;
}
