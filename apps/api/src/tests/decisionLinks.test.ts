/**
 * Decision links and the decision money column (Wave 6, SPINE-CONTRACT 1.5;
 * OPUS DECISIONS: a DecisionLink join table, and money columns to bigint paise).
 *
 * Each property below is one the record must keep on every path that writes it:
 *   - a link names a target of a registered type, and the target exists in the
 *     same tenant; a foreign or missing target is a 422 and writes nothing;
 *   - the subject link type has no target table yet, so it is refused rather
 *     than checked against nothing;
 *   - a link is recorded once: a duplicate is a 409, and the unique index refuses
 *     one even when the domain check is bypassed;
 *   - a link cannot be updated or deleted, by the application role or by the
 *     table owner; the history of what a decision was tied to stays as written;
 *   - a link writes its audit row and its event with it, and a refused link
 *     writes neither;
 *   - Decision.requiredAuthorityMinor is bigint paise: the migration converts
 *     the Decimal column exactly, refuses a value with more than two decimals
 *     rather than rounding it, and the API carries it as a string.
 *
 * Real Postgres and real contexts, no mocks. The migration is exercised on
 * scratch databases built from the migration files that precede it, so the
 * conversion and its guard are the SQL in the file, not a copy of it.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DECISION_LINK_TYPES, EVENTS, type DecisionLinkType } from '@kaizen/shared';
import * as decisions from '../domains/decisions.js';
import { bigintReplacer } from '../platform/wire.js';
import { createApp } from '../server.js';
import {
  asUser,
  expectReject,
  principalFor,
  sessionToken,
  tenantId,
  unscopedPrisma,
  withFixtureRole,
} from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const DAY = 86_400_000;
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://kaizen:kaizen@127.0.0.1:5432/kaizen_test?schema=public';
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? TEST_DB_URL.replace('//kaizen:kaizen@', '//kaizen_app:kaizen_app@');
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
const MONEY_MIGRATION = '20261013150000_decision_links_money';
const TARGET_TYPES = ['task', 'commitment', 'case', 'exception', 'document'] as const;

let KAIZEN: string;

function suffix(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function future(): Date {
  return new Date(Date.now() + 7 * DAY);
}

async function newTenant(): Promise<string> {
  const tenant = await unscopedPrisma.tenant.create({
    data: { name: `Decision links ${suffix()}`, slug: `dec-link-${suffix().toLowerCase()}` },
  });
  return tenant.id;
}

async function personIn(tid: string): Promise<string> {
  const email = `link-${suffix().toLowerCase()}@link.test`;
  const row = await unscopedPrisma.person.create({
    data: {
      tenantId: tid,
      recordCode: `PER-LINK-${suffix()}`,
      fullName: 'Link party',
      primaryEmail: email,
      primaryEmailNormalised: email,
      source: 'test',
    },
  });
  return row.id;
}

/** A live target of `linkType` in tenant `tid`, written directly as the fixture owner. */
async function targetIn(tid: string, linkType: (typeof TARGET_TYPES)[number]): Promise<string> {
  const s = suffix();
  switch (linkType) {
    case 'task':
      return (
        await unscopedPrisma.task.create({
          data: { tenantId: tid, recordCode: `TSK-LINK-${s}`, title: `Link task ${s}` },
        })
      ).id;
    case 'commitment': {
      const owner = await personIn(tid);
      return (
        await unscopedPrisma.commitment.create({
          data: {
            tenantId: tid,
            recordCode: `CMT-LINK-${s}`,
            title: `Link commitment ${s}`,
            ownerPartyId: owner,
            dueAt: future(),
            sourceType: 'manual',
            subjectType: 'decision',
            subjectId: s,
          },
        })
      ).id;
    }
    case 'case': {
      const owner = await personIn(tid);
      return (
        await unscopedPrisma.case.create({
          data: {
            tenantId: tid,
            recordCode: `CSE-LINK-${s}`,
            kind: 'customer',
            title: `Link case ${s}`,
            ownerPartyId: owner,
            responseDueAt: future(),
            visibilityTier: 'internal',
            severity: 'S2_WARNING',
          },
        })
      ).id;
    }
    case 'exception':
      return (
        await unscopedPrisma.exceptionRecord.create({
          data: {
            tenantId: tid,
            recordCode: `EXC-LINK-${s}`,
            code: 'EX-LINK-001',
            label: 'Link exception',
            severity: 'S2_WARNING',
            subjectType: 'decision',
            subjectId: `exc-${s}`,
          },
        })
      ).id;
    case 'document':
      return (
        await unscopedPrisma.document.create({
          data: {
            tenantId: tid,
            recordCode: `DOC-LINK-${s}`,
            filename: 'link.pdf',
            storageKey: `tenants/${tid}/documents/${s}`,
            mimeType: 'application/pdf',
            size: 4,
            attachedToType: 'decision',
            attachedToId: s,
            documentGroupId: `grp-${s}`,
            contentSha256: createHash('sha256').update(s).digest('hex'),
          },
        })
      ).id;
  }
}

async function raiseOne(overrides: Partial<Parameters<typeof decisions.raiseDecision>[0]> = {}) {
  return asUser(CHAIRMAN, () =>
    decisions.raiseDecision({
      question: `Link test ${suffix()}`,
      subjectType: 'link_test',
      subjectId: `subj-${suffix()}`,
      authorityBasis: 'capex',
      rejectedOptions: [{ option: 'Defer', outcome: 'Slips', risk: 'Low', cost: 'Time' }],
      ...overrides,
    }),
  );
}

async function linkAs(decisionId: string, linkType: DecisionLinkType, linkId: string) {
  return asUser(CHAIRMAN, () => decisions.linkDecision(decisionId, { linkType, linkId }));
}

async function linksOf(decisionId: string) {
  return unscopedPrisma.decisionLink.findMany({ where: { decisionId } });
}

async function eventsOf(decisionId: string) {
  return unscopedPrisma.eventRecord.findMany({
    where: { subjectEntityId: decisionId, eventName: EVENTS.DECISION_LINKED },
  });
}

beforeAll(async () => {
  KAIZEN = await tenantId();
});

describe('the link type registry', () => {
  it('names the six target kinds the decision contract allows', () => {
    expect([...DECISION_LINK_TYPES]).toEqual(['task', 'commitment', 'case', 'exception', 'document', 'subject']);
  });
});

describe('DecisionLink: a link names a target that exists in the same tenant', () => {
  for (const linkType of TARGET_TYPES) {
    it(`refuses a ${linkType} from another tenant with a 422 and writes nothing`, async () => {
      const other = await newTenant();
      const foreignId = await targetIn(other, linkType);
      const decision = await raiseOne();

      const err = await expectReject(() => linkAs(decision.id, linkType, foreignId));
      expect(err.status).toBe(422);
      expect(await linksOf(decision.id)).toEqual([]);
      expect(await eventsOf(decision.id)).toEqual([]);
    });
  }

  for (const linkType of TARGET_TYPES) {
    it(`refuses a ${linkType} that does not exist with a 422`, async () => {
      const decision = await raiseOne();
      const err = await expectReject(() => linkAs(decision.id, linkType, `missing-${suffix()}`));
      expect(err.status).toBe(422);
      expect(await linksOf(decision.id)).toEqual([]);
    });
  }

  for (const linkType of TARGET_TYPES) {
    it(`links an existing ${linkType} in the same tenant`, async () => {
      const target = await targetIn(KAIZEN, linkType);
      const decision = await raiseOne();

      const link = await linkAs(decision.id, linkType, target);
      expect(link.linkType).toBe(linkType);
      expect(link.linkId).toBe(target);
      expect(link.tenantId).toBe(KAIZEN);
      expect((await linksOf(decision.id)).map((l) => l.linkId)).toEqual([target]);
    });
  }

  it('refuses a subject link, because no registry names the subject tables yet', async () => {
    const decision = await raiseOne();
    const err = await expectReject(() => linkAs(decision.id, 'subject', decision.subjectId));
    expect(err.status).toBe(422);
    expect(await linksOf(decision.id)).toEqual([]);
  });

  it('refuses a link type outside the registry', async () => {
    const decision = await raiseOne();
    const task = await targetIn(KAIZEN, 'task');
    const err = await expectReject(() => linkAs(decision.id, 'invoice' as DecisionLinkType, task));
    expect(err.status).toBe(422);
    expect(await linksOf(decision.id)).toEqual([]);
  });
});

describe('DecisionLink: a duplicate is refused, and the index holds it', () => {
  it('refuses the same link twice with a 409, and keeps one row', async () => {
    const task = await targetIn(KAIZEN, 'task');
    const decision = await raiseOne();
    await linkAs(decision.id, 'task', task);

    const err = await expectReject(() => linkAs(decision.id, 'task', task));
    expect(err.status).toBe(409);
    expect(await linksOf(decision.id)).toHaveLength(1);
  });

  it('the unique index refuses a duplicate even when the domain check is bypassed', async () => {
    const task = await targetIn(KAIZEN, 'task');
    const decision = await raiseOne();
    await linkAs(decision.id, 'task', task);

    await expect(
      unscopedPrisma.decisionLink.create({
        data: { tenantId: KAIZEN, decisionId: decision.id, linkType: 'task', linkId: task },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('DecisionLink: authority to link', () => {
  it('refuses a principal without edit on decisions with a 403, and writes no link', async () => {
    const task = await targetIn(KAIZEN, 'task');
    const decision = await raiseOne();

    await withFixtureRole({ slug: 'dl_viewer', grants: [{ resource: 'decisions', verbs: ['view'] }] }, async () => {
      const err = await expectReject(() => decisions.linkDecision(decision.id, { linkType: 'task', linkId: task }));
      expect(err.status).toBe(403);
    });

    expect(await linksOf(decision.id)).toEqual([]);
    expect(await eventsOf(decision.id)).toEqual([]);
  });
});

describe('DecisionLink: append-only', () => {
  it('refuses UPDATE and DELETE from the application role, and the link is unchanged', async () => {
    const task = await targetIn(KAIZEN, 'task');
    const decision = await raiseOne();
    const link = await linkAs(decision.id, 'task', task);

    const app = new PrismaClient({ datasourceUrl: APP_URL });
    try {
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${KAIZEN}, true)`;
          await tx.$executeRaw`UPDATE "decision_links" SET "linkId" = 'tampered' WHERE "id" = ${link.id}`;
        }),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${KAIZEN}, true)`;
          await tx.$executeRaw`DELETE FROM "decision_links" WHERE "id" = ${link.id}`;
        }),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.$disconnect();
    }

    const still = await unscopedPrisma.decisionLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(still.linkId).toBe(task);
  });

  it('the table owner cannot update a link either', async () => {
    const task = await targetIn(KAIZEN, 'task');
    const decision = await raiseOne();
    const link = await linkAs(decision.id, 'task', task);

    await expect(
      unscopedPrisma.$executeRaw`UPDATE "decision_links" SET "linkId" = 'tampered' WHERE "id" = ${link.id}`,
    ).rejects.toThrow(/append-only/);
    const still = await unscopedPrisma.decisionLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(still.linkId).toBe(task);
  });
});

describe('DecisionLink: the audit row and the event', () => {
  it('a link writes its audit row and its decision.linked event', async () => {
    const task = await targetIn(KAIZEN, 'task');
    const decision = await raiseOne();
    const link = await linkAs(decision.id, 'task', task);

    const audit = await unscopedPrisma.auditRecord.findMany({
      where: { subjectType: 'decision_link', subjectId: link.id, action: 'create' },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.tenantId).toBe(KAIZEN);

    const events = await eventsOf(decision.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.subjectEntityId).toBe(decision.id);
  });
});

describe('Decision.requiredAuthorityMinor on the API', () => {
  it('returns the requirement as a paise string from the decision queue', async () => {
    const created = await raiseOne({ requiredAuthorityMinor: 1234567n });
    // The queue takes the 50 oldest open decisions; this one is moved to the front
    // so the assertion does not depend on how many decisions earlier tests left behind.
    await unscopedPrisma.decision.update({ where: { id: created.id }, data: { raisedAt: new Date(0) } });

    const queue = await asUser(CHAIRMAN, () => decisions.decisionQueue());
    const row = queue.find((q) => q.id === created.id);
    expect(row?.requiredAuthorityMinor).toBe('1234567');
    expect(JSON.parse(JSON.stringify(row, bigintReplacer)).requiredAuthorityMinor).toBe('1234567');
  });
});

describe('Decision money migration (20261013150000_decision_links_money)', () => {
  const stamp = suffix().toLowerCase();
  const PRE_DB = `kaizen_w6dec_pre_${stamp}`;
  const migrationFile = join(MIGRATIONS_DIR, MONEY_MIGRATION, 'migration.sql');
  const priorMigrations = readdirSync(MIGRATIONS_DIR)
    .filter((d) => /^\d{14}_/.test(d) && d < MONEY_MIGRATION)
    .sort();

  function dbUrl(name: string): string {
    const url = new URL(TEST_DB_URL);
    url.pathname = `/${name}`;
    url.search = '';
    return url.toString();
  }

  function psql(url: string, args: string[]): string {
    return execFileSync('psql', [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function admin(sql: string): void {
    psql(dbUrl(new URL(TEST_DB_URL).pathname.slice(1)), ['-c', sql]);
  }

  /** A copy of the database as it stood before this migration, so each case starts from the same state. */
  function copyOfPre(name: string): string {
    admin(`CREATE DATABASE "${name}" TEMPLATE "${PRE_DB}" OWNER kaizen`);
    return name;
  }

  function dropDb(name: string): void {
    admin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }

  async function seedDecision(client: PrismaClient, id: string, amount: string | null): Promise<void> {
    await client.$executeRaw`INSERT INTO "decisions" ("id", "tenantId", "recordCode", "question", "state", "subjectType", "subjectId", "authorityBasis", "requiredAuthorityValue", "updatedAt")
      VALUES (${id}, 'migration-fixture', ${`DEC-MIG-${id}`}, 'Migration fixture', 'Raised', 'fixture', ${id}, 'capex', ${amount}::numeric, now())`;
  }

  beforeAll(() => {
    // The state before the money migration: every migration file that sorts before it, applied in order.
    admin(`CREATE DATABASE "${PRE_DB}" OWNER kaizen`);
    for (const dir of priorMigrations) {
      psql(dbUrl(PRE_DB), ['-f', join(MIGRATIONS_DIR, dir, 'migration.sql')]);
    }
  }, 600_000);

  afterAll(() => {
    dropDb(PRE_DB);
  });

  it('converts whole and paise amounts to paise exactly, in place, and keeps the column name', async () => {
    const name = copyOfPre(`kaizen_w6dec_conv_${stamp}`);
    const client = new PrismaClient({ datasourceUrl: dbUrl(name) });
    try {
      await seedDecision(client, 'mig-a', '12345.67');
      await seedDecision(client, 'mig-b', '0.01');
      await seedDecision(client, 'mig-c', '0.00');
      await seedDecision(client, 'mig-d', null);
      await seedDecision(client, 'mig-e', '9999999999999999.99');
      await client.$disconnect();

      psql(dbUrl(name), ['-1', '-f', migrationFile]);

      const after = new PrismaClient({ datasourceUrl: dbUrl(name) });
      try {
        const [column] = await after.$queryRaw<{ data_type: string }[]>`SELECT data_type FROM information_schema.columns
          WHERE table_name = 'decisions' AND column_name = 'requiredAuthorityMinor'`;
        expect(column?.data_type).toBe('bigint');

        const rows = await after.$queryRaw<
          { id: string; minor: string | null }[]
        >`SELECT "id", "requiredAuthorityMinor"::text AS minor
          FROM "decisions" WHERE "tenantId" = 'migration-fixture' ORDER BY "id"`;
        expect(Object.fromEntries(rows.map((r) => [r.id, r.minor]))).toEqual({
          'mig-a': '1234567',
          'mig-b': '1',
          'mig-c': '0',
          'mig-d': null,
          'mig-e': '999999999999999999',
        });

        const [old] = await after.$queryRaw<
          { present: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_name = 'decisions' AND column_name = 'requiredAuthorityValue') AS present`;
        expect(old?.present).toBe(false);
      } finally {
        await after.$disconnect();
      }
    } finally {
      await client.$disconnect();
      dropDb(name);
    }
  });

  it('refuses a value with more than two decimals with RAISE, and changes nothing', async () => {
    const name = copyOfPre(`kaizen_w6dec_guard_${stamp}`);
    const client = new PrismaClient({ datasourceUrl: dbUrl(name) });
    try {
      // A declared numeric(18,2) rounds a third decimal away on insert, so a value
      // that has one can only come from a column that drifted to an unconstrained
      // type. The guard reads the stored digits, not the declared type.
      await client.$executeRawUnsafe('ALTER TABLE "decisions" ALTER COLUMN "requiredAuthorityValue" TYPE NUMERIC');
      await seedDecision(client, 'mig-x', '12345.675');
      await client.$disconnect();

      let stderr = '';
      try {
        psql(dbUrl(name), ['-1', '-f', migrationFile]);
      } catch (err) {
        stderr = String((err as { stderr?: string }).stderr ?? err);
      }
      expect(stderr).toMatch(/more than two decimal places/);

      const after = new PrismaClient({ datasourceUrl: dbUrl(name) });
      try {
        const [column] = await after.$queryRaw<{ data_type: string }[]>`SELECT data_type FROM information_schema.columns
          WHERE table_name = 'decisions' AND column_name = 'requiredAuthorityValue'`;
        expect(column?.data_type).toBe('numeric');
        const [row] = await after.$queryRaw<{ value: string }[]>`SELECT "requiredAuthorityValue"::text AS value
          FROM "decisions" WHERE "id" = 'mig-x'`;
        expect(row?.value).toBe('12345.675');
      } finally {
        await after.$disconnect();
      }
    } finally {
      await client.$disconnect();
      dropDb(name);
    }
  });
});

describe('DecisionLink over HTTP', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    server = createApp().listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    base = `http://127.0.0.1:${port}/api`;
  });

  afterAll(() => {
    server?.close();
  });

  async function chairmanToken(): Promise<string> {
    const p = await principalFor(CHAIRMAN);
    return sessionToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
  }

  const rejectedOptions = [{ option: 'Defer', outcome: 'Slips', risk: 'Low', cost: 'Time' }];

  it('takes the requirement as a paise string and returns it as one', async () => {
    const token = await chairmanToken();
    const res = await fetch(`${base}/command/decisions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        question: `HTTP money ${suffix()}`,
        subjectType: 'link_test',
        subjectId: `subj-${suffix()}`,
        authorityBasis: 'capex',
        requiredAuthorityMinor: '1234567',
        rejectedOptions,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { requiredAuthorityMinor: string };
    expect(body.requiredAuthorityMinor).toBe('1234567');
  });

  it('refuses a number where the paise string belongs', async () => {
    const token = await chairmanToken();
    const res = await fetch(`${base}/command/decisions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        question: `HTTP float ${suffix()}`,
        subjectType: 'link_test',
        subjectId: `subj-${suffix()}`,
        authorityBasis: 'capex',
        requiredAuthorityMinor: 12345.67,
        rejectedOptions,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('links a target through the route, and refuses a foreign one with a 422', async () => {
    const token = await chairmanToken();
    const decision = await raiseOne();
    const task = await targetIn(KAIZEN, 'task');
    const other = await newTenant();
    const foreign = await targetIn(other, 'task');
    const post = (linkId: string) =>
      fetch(`${base}/command/decisions/${decision.id}/links`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ linkType: 'task', linkId }),
      });

    expect((await post(foreign)).status).toBe(422);
    expect((await post(task)).status).toBe(201);
    expect((await linksOf(decision.id)).map((l) => l.linkId)).toEqual([task]);
  });
});
