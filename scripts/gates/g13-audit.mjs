// G13 (audit coverage, FX-22 "Writes with no audit"): every Prisma write in
// production code must be in a function that also calls auditWrite(). G8 checks
// the order of the calls it can see; nothing checked that the call exists. A
// write with no audit call is the defect FX-22 names (CLAUDE.md rule 5).
//
// What is a write: a call `<expr>.<model>.<op>(...)`, where <model> is a Prisma
// delegate (the lower-camel name of a `model` in apps/api/prisma/schema) and <op>
// is create, createMany, update, updateMany, upsert, delete or deleteMany. The
// receiver is not checked, so prisma, tx, db, unscopedPrisma and (tx ?? prisma)
// are all read. A Map or Set delete is not a delegate and is skipped. Not
// counted: raw SQL ($executeRaw) and writes through a computed property name.
//
// Coverage of one write (the first rule that holds):
//   1. its innermost function contains an auditWrite( call (nested callbacks
//      included, so a forEach that audits each row counts);
//   2. that function is a callback passed to $transaction( or governedWrite(),
//      and the function that makes that call contains auditWrite(). The audit
//      sits after the transaction block in the outer function, so it covers the
//      writes inside it. A callback passed to anything else (a route handler, a
//      forEach) does not borrow its enclosing function's audit.
// A write that meets neither rule is unaudited. The gap that remains with rule 2
// (the audit row is written after the transaction commits, without `tx`) is FX-24,
// not this gate.
//
// Findings and counts:
//   - unaudited-write: a failing finding. It is a ratchet per file
//     (allowlist/g13-audit.json): the count may only fall, and a count that falls
//     below its baseline fails as stale, so the baseline is lowered with the code.
//   - helper-covered: counted, not failed. The write's function calls a named
//     function in the scan whose body calls auditWrite(. Helpers are matched by
//     name, not resolved through imports, so this is a count for review.
//   - exempt: models that are the audit or event infrastructure, below.
//
// Exempt models. Writing them through auditWrite would recurse, or they hold
// no business state:
//   auditRecord   the audit chain; auditWrite writes it (audit.ts).
//   eventRecord   the event log; emit writes it (eventBus.ts).
//   outboxEvent   the transactional outbox, written with the domain write (outbox.ts).
//   session       login sessions. The rotating refresh credential is a column on
//                 Session (schema main.prisma, refreshTokenHash), not its own model.
//   jobRun        job execution bookkeeping, not business state.
//   journal*      written only by platform/ledger.ts post() (CLAUDE.md rule 2),
//                 so exempt only in that file. A journal write anywhere else is a
//                 rule 2 violation and stays visible here.
//   recordSequence  a counter: the increments that number documents, record codes and
//                 journal entries. The one administrative write, setNextNumber, is
//                 audited directly (platform/documentNumber.ts).
//   navNode       the menu, rebuilt from NAV_REGISTRY on boot and per deploy (navSync.ts).
//   dailyMetric   dashboard figures recounted each day from source rows that are audited.
//   narrative     generated Command Center prose over events; the events it cites are the record.
//   notification  in-app notices and their read state. The exception, approval or event that
//                 raised a notice is audited where it happens.
//   jobClaim      scheduler lease and attempt state (jobs/scheduler.ts), not business state.
//   jobFiringLog  dedupe claim for a job's repeat notice (jobs/scheduler.ts claimFiring).
//   eventConsumerReceipt  a subscriber's "already ran" mark for one event (platform/outbox.ts
//                 recordReceipt). The event it marks is the record; the receipt only stops a rerun.
// eventDeadLetter is not exempt: a dead letter is a delivery the business did not get.
//
// Roots: domains, routes, jobs, imports, platform, events. cli, agents, lib, seed
// and scripts are outside the roots. Tests, seed and fixture paths are excluded.
import ts from 'typescript';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
  writeAllowlist,
  REPO_ROOT,
} from './lib.mjs';

export const ROOTS = [
  'apps/api/src/domains',
  'apps/api/src/routes',
  'apps/api/src/jobs',
  'apps/api/src/imports',
  'apps/api/src/platform',
  'apps/api/src/events',
];
export const SCHEMA_DIR = 'apps/api/prisma/schema';
export const RULE = 'unaudited-write';
export const LEDGER_FILE = 'apps/api/src/platform/ledger.ts';

export const WRITE_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany']);

const TRANSACTION_WRAPPERS = new Set(['$transaction', 'governedWrite']);
const JOURNAL_MODELS = new Set(['journalEntry', 'journalLine', 'journalReversal']);

export const EXEMPT_MODELS = new Set([
  'auditRecord',
  'eventRecord',
  'outboxEvent',
  'session',
  'jobRun',
  'journalEntry',
  'journalLine',
  'journalReversal',
  'recordSequence',
  'navNode',
  'dailyMetric',
  'narrative',
  'notification',
  'jobClaim',
  'jobFiringLog',
  'eventConsumerReceipt',
]);

// Seed and fixture directories, and seed files (seed.ts, seed-demo.ts). A file
// named fixture.ts is not excluded: it is production code in a test-shaped name.
const NOT_PRODUCTION = /(^|\/)(seeds?|fixtures?)\/|(^|\/)seed[.-][^/]*$/;

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

export function inScope(rel) {
  return ROOTS.some((r) => rel.startsWith(`${r}/`)) && !isTestFile(rel) && !NOT_PRODUCTION.test(rel);
}

// The Prisma delegate names (lower-camel model names) read from the schema
// directory. A model named in a file other than main.prisma is still read.
export function readSchemaDelegates(root = REPO_ROOT) {
  const dir = join(root, SCHEMA_DIR);
  const delegates = new Set();
  if (!existsSync(dir)) return delegates;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.prisma')) continue;
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/^model\s+(\w+)\s*\{/gm)) {
      delegates.add(lowerFirst(m[1]));
    }
  }
  return delegates;
}

function writeOf(call, delegates) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !WRITE_OPS.has(callee.name.text)) return null;
  const recv = callee.expression;
  if (!ts.isPropertyAccessExpression(recv) || !delegates.has(recv.name.text)) return null;
  return { model: recv.name.text, op: callee.name.text };
}

function isExempt(model, file, exempt) {
  if (!exempt.has(model)) return false;
  return JOURNAL_MODELS.has(model) ? file === LEDGER_FILE : true;
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return '<anonymous>';
}

function enclosingFunction(node) {
  for (let p = node.parent; p; p = p.parent) if (isFunctionScope(p)) return p;
  return null;
}

// The call a function is passed to, when that call is a transaction wrapper.
function transactionCallOf(fn) {
  const p = fn.parent;
  if (!p || !ts.isCallExpression(p) || !p.arguments.includes(fn)) return null;
  return TRANSACTION_WRAPPERS.has(calledName(p)) ? p : null;
}

function subtreeCalls(node) {
  const calls = [];
  walk(node, (n) => {
    if (ts.isCallExpression(n)) calls.push(n);
  });
  return calls;
}

export function analyzeAudit(sourceMap, { delegates = new Set(), exempt = EXEMPT_MODELS } = {}) {
  const files = Object.keys(sourceMap).filter(inScope).sort();
  const parsed = files.map((file) => ({ file, sf: parseSource(file, sourceMap[file]) }));

  // Every auditWrite call per file, so a function's subtree can be checked for one
  // without walking it again for each write.
  const auditCallsByFile = new Map();
  const auditCalls = (sf) => {
    if (!auditCallsByFile.has(sf)) {
      auditCallsByFile.set(
        sf,
        subtreeCalls(sf).filter((c) => calledName(c) === 'auditWrite'),
      );
    }
    return auditCallsByFile.get(sf);
  };
  const containsAudit = (node) => {
    const start = node.getStart(node.getSourceFile());
    return auditCalls(node.getSourceFile()).some((c) => c.getStart() >= start && c.end <= node.end);
  };

  // Helpers: named functions in the scan whose subtree calls auditWrite. A name
  // that is also a Prisma method or a delegate would match every write, so it is
  // left out.
  const helpers = new Set();
  const skipName = (n) => n === 'auditWrite' || n === '<anonymous>' || WRITE_OPS.has(n) || delegates.has(n);
  for (const { sf } of parsed) {
    walk(sf, (node) => {
      if (!isFunctionScope(node)) return;
      const name = functionName(node);
      if (!skipName(name) && containsAudit(node)) helpers.add(name);
    });
  }

  const writes = [];
  let exemptCount = 0;
  for (const { file, sf } of parsed) {
    walk(sf, (node) => {
      if (!ts.isCallExpression(node)) return;
      const w = writeOf(node, delegates);
      if (!w) return;
      if (isExempt(w.model, file, exempt)) {
        exemptCount += 1;
        return;
      }
      writes.push({ file, sf, node, line: lineOf(sf, node), ...w });
    });
  }

  // The scope that must hold the audit: the innermost function, climbed through
  // transaction callbacks.
  const coverOf = (write) => {
    let scope = enclosingFunction(write.node) ?? write.sf;
    for (;;) {
      if (containsAudit(scope)) return { covered: true, scope };
      const call = isFunctionScope(scope) ? transactionCallOf(scope) : null;
      if (!call) return { covered: false, scope };
      scope = enclosingFunction(call) ?? call.getSourceFile();
    }
  };

  const findings = [];
  let direct = 0;
  let helperCovered = 0;
  const helperUsed = new Map();
  for (const w of writes) {
    const { covered, scope } = coverOf(w);
    if (covered) {
      direct += 1;
      continue;
    }
    const helperNames = subtreeCalls(scope)
      .map(calledName)
      .filter((n) => helpers.has(n));
    if (helperNames.length > 0) {
      helperCovered += 1;
      for (const n of new Set(helperNames)) helperUsed.set(n, (helperUsed.get(n) ?? 0) + 1);
      continue;
    }
    const named = isFunctionScope(scope) ? functionName(scope) : '<module>';
    const where = named === '<anonymous>' ? 'an unnamed function' : named;
    findings.push({
      file: w.file,
      line: w.line,
      scope: named,
      rule: RULE,
      message:
        `${w.model}.${w.op}() has no auditWrite() in ${where} or in a transaction it runs in. ` +
        'Add auditWrite after the write and before emit (CLAUDE.md rule 5), or, for a read model or cache, ' +
        'exempt it in allowlist/g13-audit.json with the reason.',
    });
  }

  const unknownExempt = delegates.size > 0 ? [...exempt].filter((m) => !delegates.has(m)) : [];

  return {
    findings,
    writes: writes.length,
    direct,
    helperCovered,
    exempt: exemptCount,
    helpers: helpers.size,
    helperUsed,
    unknownExempt,
  };
}

export function collectG13({ root } = {}) {
  const sourceMap = {};
  for (const rel of listSources(ROOTS, { root })) sourceMap[rel] = readSource(rel, root);
  return analyzeAudit(sourceMap, { delegates: readSchemaDelegates(root) });
}

export function runG13({ root } = {}) {
  const result = collectG13({ root });
  const { entries } = loadAllowlist('g13-audit');
  const { problems, baselined } = checkRatchet({ gate: 'G13', findings: result.findings, entries });
  const exemptProblems = result.unknownExempt.map(
    (m) => `G13 stale exemption: '${m}' is not a model in ${SCHEMA_DIR}. Remove it from EXEMPT_MODELS.`,
  );
  return {
    id: 'G13',
    title: 'audit coverage (ratchet, apps/api/src)',
    problems: [...exemptProblems, ...problems],
    summary:
      `${result.writes} write(s) in scope, ${result.exempt} exempt, ${result.direct} audited, ` +
      `${result.helperCovered} audited via a helper (counted), ${result.findings.length} unaudited, ` +
      `${baselined} baselined`,
  };
}

// Regenerates allowlist/g13-audit.json from the scan. Run through run.mjs
// --write-baseline, or on its own, so the other gates' baselines are not touched.
export function writeG13Baseline({ root } = {}) {
  return writeAllowlist('g13-audit', {
    gate: 'G13',
    description:
      'Ratchet for CLAUDE.md rule 5 (every write audited). Per-file counts of Prisma writes whose function has no auditWrite and no audited helper. A count may only fall. Regenerate with node scripts/gates/run.mjs --write-baseline.',
    findings: collectG13({ root }).findings,
    managedRules: [RULE],
    defaultReason:
      'Baselined at P0 audit coverage (FX-22). This write has no auditWrite in its function or transaction. Add one (rule 5), or exempt it with the reason if it is a read model or cache; do not raise the count.',
  });
}
