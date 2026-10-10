/**
 * FX-20 / FX-21 — the audit registry.
 *
 * `auditWrite` used to return without writing anything when the subject type
 * was not on the governed registry, so a domain could ship a write that looked
 * audited and was not (the cashbook case). `force: true` was the workaround
 * that bypassed the registry, and it spread to forty-odd call sites.
 *
 * Checks, without a database:
 *   1. Runtime: an unregistered subject type is refused, not silently dropped.
 *   2. Static: every subject type literal handed to `auditWrite` or to the
 *      lifecycle `transition` helper is registered by some
 *      `registerGovernedEntities` call in apps/api/src. Static because the
 *      registry is filled by module side effects; importing every domain here
 *      would prove only what happened to be imported.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { auditWrite, isGoverned } from '../platform/audit.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'tests' || name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Blanks out comments while leaving string literals intact, so that a doc
 * comment quoting `auditWrite({ subjectType: 'x' })` is not read as a call.
 */
function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  ';
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') { out += src[i]; i++; }
        out += src[i];
        i++;
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index just past the bracket that closes the one opening at `open`. */
function closeIndex(code: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < code.length && code[i] !== ch) { if (code[i] === '\\') i++; i++; }
    } else if (pairs[ch]) {
      stack.push(pairs[ch]!);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== ch) throw new Error(`unbalanced ${ch} at ${open}`);
      if (stack.length === 0) return i + 1;
    }
  }
  throw new Error(`no close for bracket at ${open}`);
}

const FILES = sourceFiles(SRC).map((file) => ({ file, code: codeOnly(readFileSync(file, 'utf8')) }));

interface AuditCall {
  file: string;
  literalSubject: string | null;
  forced: boolean;
}

function auditCalls(): AuditCall[] {
  const calls: AuditCall[] = [];
  for (const { file, code } of FILES) {
    const re = /\b(auditWrite|transition)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const open = m.index + m[0].length - 1;
      const body = code.slice(open, closeIndex(code, open));
      // `transition` is an audit call only when its input carries a subjectType;
      // the other transition helpers (machines, workflow states) do not.
      if (m[1] === 'transition' && !/\bsubjectType\b/.test(body)) continue;
      const lit = /\bsubjectType\s*:\s*'([^']+)'/.exec(body);
      calls.push({
        file: relative(SRC, file),
        literalSubject: lit ? lit[1]! : null,
        forced: /\bforce\s*:\s*true\b|\bforce\s*[,}]/.test(body),
      });
    }
  }
  return calls;
}

/** Every literal subject named in any registerGovernedEntities call in the API source. */
function registeredSubjects(): Set<string> {
  const set = new Set<string>();
  for (const { code } of FILES) {
    const re = /registerGovernedEntities\(\s*'[^']+'\s*,\s*\[/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const open = m.index + m[0].length - 1;
      const list = code.slice(open, closeIndex(code, open));
      for (const s of list.matchAll(/'([^']+)'/g)) set.add(s[1]!);
    }
  }
  return set;
}

describe('FX-20: an unregistered subject type is refused, not dropped', () => {
  it('auditWrite throws for a subject type nobody registered', async () => {
    await expect(
      auditWrite({ action: 'create', subjectType: 'fx20_not_a_real_subject', subjectId: 'x' }),
    ).rejects.toThrow(/not registered/);
  });

  it('isGoverned is false for that same type', () => {
    expect(isGoverned('fx20_not_a_real_subject')).toBe(false);
  });
});

describe('FX-20: every audited subject type literal is registered', () => {
  const calls = auditCalls();

  it('finds the audit call sites it is meant to check', () => {
    // Guards the scanner itself: if brace matching breaks, this set collapses
    // and the check below passes vacuously.
    const literal = calls.filter((c) => c.literalSubject);
    expect(literal.length).toBeGreaterThan(250);
    expect(registeredSubjects().size).toBeGreaterThan(150);
  });

  it('every subjectType literal passed to auditWrite or transition is registered', () => {
    const registered = registeredSubjects();
    const missing = [
      ...new Set(
        calls
          .filter((c) => c.literalSubject && !registered.has(c.literalSubject))
          .map((c) => `${c.literalSubject} (${c.file})`),
      ),
    ];
    expect(missing).toEqual([]);
  });
});

describe('FX-21: no auditWrite or transition call passes force', () => {
  it('no call site sets force', () => {
    const forced = [...new Set(auditCalls().filter((c) => c.forced).map((c) => c.file))];
    expect(forced).toEqual([]);
  });

  it('AuditWriteInput has no force option', () => {
    const src = readFileSync(join(SRC, 'platform', 'audit.ts'), 'utf8');
    const iface = /export interface AuditWriteInput \{[\s\S]*?\n\}/.exec(src);
    expect(iface?.[0]).toBeDefined();
    expect(iface![0]).not.toMatch(/\bforce\??:/);
  });
});

/**
 * FX-22 — registration closure per writer module.
 *
 * The global check above passes if *some* module registers a subject. A
 * job or script that imports only the writer, not the module holding the
 * registration, then throws at runtime ("not registered") on its first audited
 * write. So for each module that audits a subject, the registration must sit in
 * that module or in one it reaches through a static import. Dynamic `import()`
 * does not count: it is not guaranteed to have run when the write happens.
 */
function staticImportsOf(file: string, code: string, byFile: Map<string, string>): string[] {
  const out: string[] = [];
  const re = /\b(?:import|export)\b[^'"`;]*?\bfrom\s*'(\.{1,2}\/[^']+)'|^\s*import\s*'(\.{1,2}\/[^']+)'/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const spec = (m[1] ?? m[2])!.replace(/\.js$/, '');
    const base = resolve(dirname(file), spec);
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (byFile.has(candidate)) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}

function registeredIn(code: string): string[] {
  const names: string[] = [];
  const re = /registerGovernedEntities\(\s*'[^']+'\s*,\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    for (const s of code.slice(open, closeIndex(code, open)).matchAll(/'([^']+)'/g)) names.push(s[1]!);
  }
  return names;
}

describe('FX-22: each writer module has its subjects registered in its own import closure', () => {
  it('no audited subject is registered only in a module the writer does not statically import', () => {
    const calls = auditCalls();
    const byFile = new Map(FILES.map(({ file, code }) => [file, code]));
    const missing: string[] = [];
    for (const { file } of FILES) {
      const subjects = new Set(calls.filter((c) => c.file === relative(SRC, file)).map((c) => c.literalSubject).filter((s): s is string => !!s));
      if (subjects.size === 0) continue;
      const reach = new Set<string>();
      const stack = [file];
      while (stack.length) {
        const f = stack.pop()!;
        if (reach.has(f)) continue;
        reach.add(f);
        stack.push(...staticImportsOf(f, byFile.get(f)!, byFile));
      }
      const have = new Set<string>();
      for (const f of reach) for (const s of registeredIn(byFile.get(f)!)) have.add(s);
      for (const s of subjects) if (!have.has(s)) missing.push(`${relative(SRC, file)}: ${s}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('FX-22: lifecycle transition audits before it emits', () => {
  it('auditWrite precedes emit inside transition()', () => {
    // Audit-then-emit, as in CLAUDE.md rule 5: an event that reaches a subscriber
    // for a change the audit log never recorded is the state the log exists to rule out.
    const code = codeOnly(readFileSync(join(SRC, 'platform', 'lifecycle.ts'), 'utf8'));
    const body = code.slice(code.indexOf('export async function transition'));
    const audit = body.indexOf('await auditWrite(');
    const emitAt = body.indexOf('await emit(');
    expect(audit).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(-1);
    expect(audit).toBeLessThan(emitAt);
  });
});
