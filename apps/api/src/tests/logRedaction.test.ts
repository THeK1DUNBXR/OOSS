/**
 * G11, log redaction (CI-GATES-DRAFT G11; phase-0 0.4). Every field in
 * REGULATED_EXCLUDED_FIELDS gets its own sentinel value, and that value must not
 * appear in anything the process writes.
 *
 *   (a) a log line built from a context object that carries the field;
 *   (b) an error that carries the field, logged by the request error handler and
 *       answered over HTTP;
 *   (c) a normal response, from a real route, for a record that carries the field.
 *
 * No mocks and no spies: the output is captured from a destination the logger
 * already accepts (a), from a child process running the real singleton logger and
 * error middleware (b, see logRedaction.child.ts), and from the HTTP body of a
 * real route over the real app (c).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REGULATED_EXCLUDED_FIELDS } from '@kaizen/shared';
import { createApp } from '../server.js';
import { createLogger } from '../platform/logger.js';
import { asUser, prisma, principalFor, sessionToken, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';

const FIELDS: readonly string[] = REGULATED_EXCLUDED_FIELDS;
const sentinels = new Map(FIELDS.map((f) => [f, `sentinel-${f}-${randomBytes(8).toString('hex')}`]));
const sentinelOf = (field: string): string => {
  const s = sentinels.get(field);
  if (!s) throw new Error(`no sentinel for ${field}`);
  return s;
};

const CHAIRMAN = 'chairman@kaizen.co.in';

describe('G11 sanity', () => {
  it('names at least one regulated field, so the sweep below is not empty', () => {
    expect(FIELDS.length).toBeGreaterThan(0);
    expect(new Set(FIELDS).size).toBe(FIELDS.length);
  });
});

describe('(a) the logger drops a regulated field from any line it writes', () => {
  it.each(FIELDS.map((f) => [f]))('%s', (field) => {
    const sentinel = sentinelOf(field);
    const chunks: string[] = [];
    const log = createLogger({ destination: { write: (s: string) => void chunks.push(s) } });
    log.info({ tenantId: 'tenant-1', requestId: 'req-1', [field]: sentinel, nested: { [field]: sentinel } }, 'probe');
    log.child({ [field]: sentinel }).info('child probe');
    const output = chunks.join('');
    // The positive control: the line was written, so an absent sentinel means dropped, not lost.
    expect(output).toContain('"requestId":"req-1"');
    expect(output).toContain('"msg":"child probe"');
    expect(output).not.toContain(sentinel);
  });
});

describe('(b) an error carrying a regulated field, logged and answered over HTTP', () => {
  let output = '';
  let status: number | null = null;

  beforeAll(() => {
    const probes = FIELDS.map((field) => ({ field, sentinel: sentinelOf(field) }));
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', fileURLToPath(new URL('./logRedaction.child.ts', import.meta.url))],
      {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: { ...process.env, NODE_ENV: 'development', LOG_REDACTION_PROBES: JSON.stringify(probes) },
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    status = child.status;
    output = `${child.stdout}\n${child.stderr}`;
  });

  it('runs the child to completion, so the output below is real', () => {
    expect(status, output.slice(-2000)).toBe(0);
    // Positive controls: the error reached the logger and the HTTP body was written.
    expect(output).toContain('"msg":"unhandled error"');
    expect(output).toContain('PROBE-HTTP 500 {"error":{"code":"INTERNAL"');
    expect(output).toContain('"msg":"probe line"');
  });

  it.each(FIELDS.map((f) => [f]))('%s never reaches the logged error or the response body', (field) => {
    expect(output).not.toContain(sentinelOf(field));
  });
});

describe('(c) a normal response for a record that carries a regulated field', () => {
  // employee360 (routes/hcm/workforce.routes.ts) is the one route in the suite that
  // returns a Person and an EmploymentRelationship together. Of the regulated fields,
  // these four are columns on those two records: bloodGroup on Person (schema
  // main.prisma:253), panNumber, aadhaarReference and uanNumber on
  // EmploymentRelationship (main.prisma:4509-4511). The other names are columns on
  // records no response in this suite returns, so they have no route to check here.
  const CARRIED = ['bloodGroup', 'panNumber', 'aadhaarReference', 'uanNumber'] as const;
  let server: Server;
  let base: string;
  let chairman: TestPrincipal;
  let employmentId: string;
  let personId: string;
  let personName: string;
  let original: { person: { bloodGroup: string | null }; employment: Record<string, string | null> };

  beforeAll(async () => {
    const tenant = await tenantId();
    chairman = await principalFor(CHAIRMAN);
    const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({
      where: { tenantId: tenant, deletedAt: null },
      include: { person: true },
    });
    employmentId = employment.id;
    personId = employment.personId;
    personName = employment.person.fullName;
    original = {
      person: { bloodGroup: employment.person.bloodGroup },
      employment: {
        panNumber: employment.panNumber,
        aadhaarReference: employment.aadhaarReference,
        uanNumber: employment.uanNumber,
      },
    };
    await asUser(CHAIRMAN, async () => {
      await prisma.person.update({ where: { id: personId }, data: { bloodGroup: sentinelOf('bloodGroup') } });
      await prisma.employmentRelationship.update({
        where: { id: employmentId },
        data: {
          panNumber: sentinelOf('panNumber'),
          aadhaarReference: sentinelOf('aadhaarReference'),
          uanNumber: sentinelOf('uanNumber'),
        },
      });
    });
    server = createApp().listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}/api`;
  });

  afterAll(async () => {
    server?.close();
    await asUser(CHAIRMAN, async () => {
      await prisma.person.update({ where: { id: personId }, data: { bloodGroup: original.person.bloodGroup } });
      await prisma.employmentRelationship.update({ where: { id: employmentId }, data: original.employment });
    });
  });

  it('stores each sentinel, so the response check below is not checking an empty row', async () => {
    const stored = await unscopedPrisma.employmentRelationship.findUniqueOrThrow({
      where: { id: employmentId },
      include: { person: true },
    });
    expect(stored.person.bloodGroup).toBe(sentinelOf('bloodGroup'));
    expect(stored.panNumber).toBe(sentinelOf('panNumber'));
    expect(stored.aadhaarReference).toBe(sentinelOf('aadhaarReference'));
    expect(stored.uanNumber).toBe(sentinelOf('uanNumber'));
  });

  it('answers the chairman with the record and none of the carried sentinels', async () => {
    const token = await sessionToken({
      userId: chairman.userId,
      tenantId: chairman.tenantId,
      affiliationId: chairman.affiliationId,
      stepUp: true,
    });
    const res = await fetch(`${base}/hcm/workforce/employees/${employmentId}/360`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.text();
    expect(res.status, body.slice(0, 500)).toBe(200);
    // The positive control: the body is the employee's record, not an error page.
    expect(JSON.parse(body).person.fullName).toBe(personName);
    for (const field of CARRIED) expect(body).not.toContain(sentinelOf(field));
  });
});
