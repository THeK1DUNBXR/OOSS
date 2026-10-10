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
import { join, relative } from 'node:path';
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
