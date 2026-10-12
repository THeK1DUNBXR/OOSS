// G8(a) (governed-write scan): a write that is not registered, forced, or
// ordered wrongly cannot reach the audit log silently. These cases plant each
// finding and the look-alikes that must stay quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGoverned } from './g8-governed.mjs';

const PROD = 'apps/api/src/domains/fixture.ts';
const REGISTER = "registerGovernedEntities('crm', ['lead', 'task']);\n";

function analyze(files) {
  return analyzeGoverned(files);
}

function rules(result) {
  return result.findings.map((f) => f.rule);
}

test('a write in order with a registered subjectType is clean', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: [
      'export async function createLead(tx, input) {',
      '  await assertCan(auth, "create", "lead");',
      "  await auditWrite({ action: 'create', subjectType: 'lead', subjectId: input.id, tx });",
      "  await emit({ type: 'kz.crm.lead.created', tx });",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.unresolved, 0);
});

test('flags a subjectType that no registerGovernedEntities call names', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: [
      'export async function f(tx) {',
      "  await auditWrite({ action: 'create', subjectType: 'widget', subjectId: '1', tx });",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(rules(result), ['unregistered-subjectType']);
  assert.equal(result.findings[0].file, PROD);
  assert.equal(result.findings[0].line, 2);
  assert.match(result.findings[0].message, /widget/);
});

test('flags force: true inside an auditWrite argument', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: [
      'export async function f(tx) {',
      "  await auditWrite({ action: 'create', subjectType: 'lead', subjectId: '1', force: true });",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(rules(result), ['force-true']);
  assert.equal(result.findings[0].line, 2);
});

test('does not flag force: true on an unrelated call', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: 'export async function f(p) { await rm(p, { force: true }); }\n',
  });
  assert.deepEqual(result.findings, []);
});

test('flags emit before auditWrite in one function body', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: [
      'export async function f(tx) {',
      "  await assertCan(auth, 'create', 'lead');",
      "  await emit({ type: 'kz.crm.lead.created', tx });",
      "  await auditWrite({ action: 'create', subjectType: 'lead', subjectId: '1', tx });",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(rules(result), ['emit-before-auditWrite']);
  assert.equal(result.findings[0].line, 3);
});

test('flags auditWrite before assertCan in one function body', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: [
      'export async function f(tx) {',
      "  await auditWrite({ action: 'create', subjectType: 'lead', subjectId: '1', tx });",
      "  await assertCan(auth, 'create', 'lead');",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(rules(result), ['auditWrite-before-assertCan']);
});

test('attributes each call to its innermost function, so a callback is not compared with its parent', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: [
      'export async function f(tx) {',
      "  await emit({ type: 'kz.crm.lead.created' });",
      '  await tx.$transaction(async (t) => {',
      "    await auditWrite({ action: 'create', subjectType: 'lead', subjectId: '1', tx: t });",
      '  });',
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(result.findings, []);
});

test('ignores calls that appear only in comments and strings', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: [
      "// auditWrite({ subjectType: 'widget', force: true })",
      '/* emit( before auditWrite( */',
      'const s = "auditWrite({ subjectType: \'widget\' })";',
      '',
    ].join('\n'),
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.unresolved, 0);
});

test('counts a subjectType it cannot read as unresolved, not as a finding', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: [
      'export async function f(kind, tx) {',
      '  await auditWrite({ action: "create", subjectType: kind, subjectId: "1", tx });',
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.unresolved, 1);
});

test('resolves a subjectType held in a same-file string constant', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    [PROD]: [
      "const SUBJECT = 'widget';",
      'export async function f(tx) {',
      '  await auditWrite({ action: "create", subjectType: SUBJECT, subjectId: "1", tx });',
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(rules(result), ['unregistered-subjectType']);
  assert.match(result.findings[0].message, /widget/);
});

test('skips test files for every check', () => {
  const result = analyze({
    'apps/api/src/platform/registry.ts': REGISTER,
    'apps/api/src/tests/fixture.test.ts': [
      'export async function f(tx) {',
      "  await emit({ type: 'x' });",
      "  await auditWrite({ action: 'create', subjectType: 'widget', subjectId: '1', force: true, tx });",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(result.findings, []);
});

test('a registration that sits in a test file does not register the subject for production', () => {
  const result = analyze({
    'apps/api/src/tests/fixture.test.ts': "registerGovernedEntities('x', ['widget']);\n",
    [PROD]: [
      'export async function f(tx) {',
      "  await auditWrite({ action: 'create', subjectType: 'widget', subjectId: '1', tx });",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(rules(result), ['unregistered-subjectType']);
});

test('reads a registration list written over several lines and several calls', () => {
  const result = analyze({
    'apps/api/src/platform/a.ts': "registerGovernedEntities('crm', [\n  'lead',\n  'task',\n]);\n",
    'apps/api/src/domains/b.ts': "registerGovernedEntities('fin', ['invoice']);\n",
    [PROD]: [
      'export async function f(tx) {',
      "  await auditWrite({ action: 'create', subjectType: 'task', subjectId: '1', tx });",
      "  await auditWrite({ action: 'create', subjectType: 'invoice', subjectId: '1', tx });",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(result.findings, []);
});
