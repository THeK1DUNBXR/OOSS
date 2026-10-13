// G13 (audit coverage): a Prisma write with no auditWrite in its function or in
// the transaction it runs in is found. These cases plant each shape and the
// look-alikes that must stay quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAudit, EXEMPT_MODELS } from './g13-audit.mjs';
import { checkRatchet } from './lib.mjs';

const PROD = 'apps/api/src/domains/fixture.ts';
const DELEGATES = new Set([
  'lead',
  'task',
  'auditRecord',
  'journalEntry',
  'transaction',
  'recordSequence',
  'eventDeadLetter',
]);

function analyze(text, file = PROD, extra = {}) {
  return analyzeAudit({ [file]: text }, { delegates: DELEGATES, ...extra });
}

test('an audited write in its own function is clean and counted as audited', () => {
  const result = analyze(
    [
      'export async function createLead(tx, input) {',
      '  const row = await tx.lead.create({ data: input });',
      "  await auditWrite({ action: 'create', subjectType: 'lead', subjectId: row.id, tx });",
      "  await emit({ name: 'kz.crm.lead.created', tx });",
      '  return row;',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.writes, 1);
  assert.equal(result.direct, 1);
});

test('finds a write whose function has no auditWrite', () => {
  const result = analyze(
    [
      'export async function renameLead(id, name) {',
      '  await prisma.lead.update({ where: { id }, data: { name } });',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    result.findings.map((f) => [f.file, f.line, f.rule, f.scope]),
    [[PROD, 2, 'unaudited-write', 'renameLead']],
  );
});

test('skips a model that is audit or event infrastructure', () => {
  const result = analyze(
    ['export async function f(tx) {', "  await tx.auditRecord.create({ data: { action: 'create' } });", '}', ''].join(
      '\n',
    ),
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.exempt, 1);
  assert.equal(result.writes, 0);
});

test('a reviewed counter is exempt, and a dead letter is not', () => {
  const result = analyze(
    [
      'export async function bump(tx) {',
      '  await tx.recordSequence.upsert({ where: {}, create: {}, update: {} });',
      '}',
      'export async function deadLetter(tx, row) {',
      '  await tx.eventDeadLetter.create({ data: row });',
      '}',
      '',
    ].join('\n'),
    'apps/api/src/platform/fixture.ts',
  );
  assert.deepEqual(
    result.findings.map((f) => [f.line, f.scope]),
    [[5, 'deadLetter']],
  );
  assert.equal(result.exempt, 1);
});

test('a journal write is exempt only in platform/ledger.ts', () => {
  const text = 'export async function post(tx) { await tx.journalEntry.create({ data: {} }); }\n';
  assert.equal(analyze(text, 'apps/api/src/platform/ledger.ts').findings.length, 0);
  const elsewhere = analyze(text, 'apps/api/src/domains/fixture.ts');
  assert.deepEqual(
    elsewhere.findings.map((f) => f.rule),
    ['unaudited-write'],
  );
});

test('a write inside a $transaction callback is covered by the audit after the callback', () => {
  const result = analyze(
    [
      'export async function reprice(id) {',
      '  const updated = await prisma.$transaction(async (tx) => {',
      '    return tx.lead.update({ where: { id }, data: {} });',
      '  });',
      "  await auditWrite({ action: 'update', subjectType: 'lead', subjectId: id });",
      '  return updated;',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.direct, 1);
});

test('a callback that is not a transaction does not borrow its enclosing function audit', () => {
  const result = analyze(
    [
      'export async function importRows(rows) {',
      '  rows.forEach((row) => {',
      '    prisma.lead.create({ data: row });',
      '  });',
      "  await auditWrite({ action: 'create', subjectType: 'lead', subjectId: 'batch' });",
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    result.findings.map((f) => [f.line, f.scope]),
    [[3, '<anonymous>']],
  );
});

test('a Map delete is not a write, and neither is a method on a non-delegate receiver', () => {
  const result = analyze(
    [
      'export function f(actualBy, cache, key) {',
      '  actualBy.delete(key);',
      '  cache.update(key);',
      '  cache.lead.get(key);',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.writes, 0);
});

test('a write whose function calls an audited helper is counted, not flagged', () => {
  const result = analyze(
    [
      'export async function recordIt(tx, row) {',
      "  await auditWrite({ action: 'create', subjectType: 'lead', subjectId: row.id, tx });",
      '}',
      '',
      'export async function caller(tx, row) {',
      '  await tx.task.create({ data: row });',
      '  await recordIt(tx, row);',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(result.findings, []);
  assert.equal(result.helperCovered, 1);
  assert.deepEqual([...result.helperUsed], [['recordIt', 1]]);
});

test('test, seed and fixture files are not scanned', () => {
  const text = 'export async function f() { await prisma.lead.create({ data: {} }); }\n';
  for (const file of [
    'apps/api/src/tests/fixture.ts',
    'apps/api/src/domains/fixture.test.ts',
    'apps/api/src/domains/seed/demo.ts',
    'apps/api/src/platform/fixtures/rows.ts',
    'apps/api/src/cli/fixture.ts',
  ]) {
    assert.deepEqual(analyze(text, file).findings, [], file);
  }
});

test('the ratchet fails a file whose unaudited count rises above its baseline', () => {
  const findings = analyze(
    [
      'export async function a() { await prisma.lead.create({ data: {} }); }',
      'export async function b() { await prisma.lead.create({ data: {} }); }',
      '',
    ].join('\n'),
  ).findings;
  const { problems } = checkRatchet({
    gate: 'G13',
    findings,
    entries: [{ file: PROD, rule: 'unaudited-write', count: 1, reason: 'baseline' }],
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /unaudited-write/);
});

test('an exemption naming a model the schema does not have is reported', () => {
  const result = analyze('export const x = 1;\n', PROD, { delegates: new Set(['lead']) });
  assert.ok(result.unknownExempt.includes('auditRecord'));
  assert.ok(EXEMPT_MODELS.has('auditRecord'));
});
