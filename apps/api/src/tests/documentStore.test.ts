/**
 * The document store (Wave 6 PR 2; CAP-DOC-01).
 *
 * Real Postgres, real request contexts, real object storage on disk. The
 * storage root is the one vitest.config.ts names for the run, so nothing here
 * is a stand-in: a file the test reads back is a file the writer wrote.
 *
 * What these tests hold the store to:
 *   - tenant isolation, at the row, the storage key and the database role;
 *   - a version's bytes are the bytes its hash names, on write and on read;
 *   - a version chain with one head, and no fork;
 *   - lifecycle moves that the table allows, and nothing else;
 *   - no delete path, in the writer, the routes or the database;
 *   - audit and event commit or vanish with the row they describe.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { isCanonicalEventName } from '@kaizen/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { unscopedPrisma } from '../platform/db.js';
import { isGoverned } from '../platform/audit.js';
import * as documents from '../domains/documents.js';
import { asUser, expectReject, principalFor, tenantId } from './helpers.js';

const CHAIRMAN = 'chairman@kaizen.co.in';
const EMPLOYEE = 'employee@kaizen.co.in';
const INJECTED = 'injected document write failure';
const STORAGE_ROOT = process.env.DOCUMENT_STORAGE_DIR ?? '';

let TID: string;
let suffixCounter = 0;

function suffix(): string {
  suffixCounter += 1;
  return `${Date.now().toString(36)}${suffixCounter}${Math.random().toString(36).slice(2, 6)}`;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bodyOf(label: string): Buffer {
  return Buffer.from(`document body ${label} ${suffix()}`);
}

function uploadInput(overrides: Partial<documents.RegisterUploadInput> = {}): documents.RegisterUploadInput {
  const bytes = overrides.bytes ?? bodyOf('upload');
  return {
    filename: `contract-${suffix()}.pdf`,
    mimeType: 'application/pdf',
    bytes,
    contentSha256: sha256Hex(bytes),
    attachedToType: 'contract',
    attachedToId: `ctr-${suffix()}`,
    ...overrides,
  };
}

async function countDocuments(where: Record<string, unknown> = {}): Promise<number> {
  return unscopedPrisma.document.count({ where: { tenantId: TID, ...where } });
}

async function countAudit(subjectType: string, subjectId?: string): Promise<number> {
  return unscopedPrisma.auditRecord.count({
    where: { tenantId: TID, subjectType, ...(subjectId ? { subjectId } : {}) },
  });
}

async function countEvents(eventName: string): Promise<number> {
  return unscopedPrisma.eventRecord.count({ where: { tenantId: TID, eventName } });
}

/** Objects on disk under this tenant's document prefix. A stored file with no row is a leak. */
function storedObjects(): string[] {
  try {
    return readdirSync(join(STORAGE_ROOT, 'tenants', TID, 'documents'), { recursive: true }) as string[];
  } catch {
    return [];
  }
}

/** A raw row in another tenant, for the cross-tenant cases. */
async function foreignTenantDocument(): Promise<{ tenantId: string; id: string; storageKey: string }> {
  const other = await unscopedPrisma.tenant.create({
    data: { name: 'Other document tenant', slug: `doc-other-${suffix().toLowerCase()}` },
  });
  const key = `tenants/${other.id}/documents/${suffix()}`;
  const row = await unscopedPrisma.document.create({
    data: {
      tenantId: other.id,
      recordCode: `DOC-OTHER-${suffix()}`,
      filename: 'theirs.pdf',
      storageKey: key,
      mimeType: 'application/pdf',
      size: 4,
      attachedToType: 'contract',
      attachedToId: 'theirs',
      documentGroupId: `grp-${suffix()}`,
      contentSha256: sha256Hex(Buffer.from('theirs')),
    },
  });
  return { tenantId: other.id, id: row.id, storageKey: key };
}

async function refuseDocumentAudit(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w6_refuse_document_audit() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w6_refuse_document_audit BEFORE INSERT ON audit_records
     FOR EACH ROW WHEN (NEW."subjectType" = 'document')
     EXECUTE FUNCTION w6_refuse_document_audit()`,
  );
}

async function refuseDocumentEvent(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION w6_refuse_document_event() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN RAISE EXCEPTION '${INJECTED}'; END; $$`,
  );
  await unscopedPrisma.$executeRawUnsafe(
    `CREATE TRIGGER w6_refuse_document_event BEFORE INSERT ON event_records
     FOR EACH ROW WHEN (NEW."eventName" = 'kz.doc.document.uploaded')
     EXECUTE FUNCTION w6_refuse_document_event()`,
  );
}

async function restoreDocumentTriggers(): Promise<void> {
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w6_refuse_document_audit ON audit_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w6_refuse_document_audit()`);
  await unscopedPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS w6_refuse_document_event ON event_records`);
  await unscopedPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS w6_refuse_document_event()`);
}

afterEach(async () => {
  await restoreDocumentTriggers();
});

async function setup(): Promise<void> {
  TID = await tenantId();
}

describe('document store: tenant isolation', () => {
  it('a document of another tenant is not found, not listed and not readable', async () => {
    await setup();
    const foreign = await foreignTenantDocument();
    await asUser(CHAIRMAN, async () => {
      const err = await expectReject(() => documents.getDocument(foreign.id));
      expect(err.status).toBe(404);
      const listed = await documents.listDocuments({});
      expect(listed.map((d) => d.id)).not.toContain(foreign.id);
      const read = await expectReject(() => documents.readContent(foreign.id));
      expect(read.status).toBe(404);
    });
  });

  it('writes the object under the tenant prefix, and the row records that key', async () => {
    await setup();
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    expect(doc.storageKey.startsWith(`tenants/${TID}/documents/`)).toBe(true);
    expect(existsSync(join(STORAGE_ROOT, doc.storageKey))).toBe(true);
  });

  it('the storage refuses a key outside the tenant it is asked for, and a path that climbs out of it', async () => {
    await setup();
    const other = await foreignTenantDocument();
    const { activeObjectStorage } = await import('../platform/objectStorage.js');
    const storage = activeObjectStorage();
    await expect(storage.put(TID, `tenants/${other.tenantId}/documents/x`, Buffer.from('x'))).rejects.toThrow(/tenant/);
    await expect(storage.get(TID, other.storageKey)).rejects.toThrow(/tenant/);
    await expect(storage.get(TID, `tenants/${TID}/documents/../../../${other.tenantId}/documents/x`)).rejects.toThrow();
  });

  it('a row that names another tenant key cannot be read back through the writer', async () => {
    await setup();
    const other = await foreignTenantDocument();
    const mine = await unscopedPrisma.document.create({
      data: {
        tenantId: TID,
        recordCode: `DOC-FORGED-${suffix()}`,
        filename: 'forged.pdf',
        storageKey: other.storageKey,
        mimeType: 'application/pdf',
        size: 4,
        attachedToType: 'contract',
        attachedToId: 'forged',
        documentGroupId: `grp-${suffix()}`,
        contentSha256: sha256Hex(Buffer.from('theirs')),
      },
    });
    await asUser(CHAIRMAN, async () => {
      await expect(documents.readContent(mine.id)).rejects.toThrow(/tenant/);
    });
  });

  it('the database role sees no row of another tenant, even on a raw query', async () => {
    await setup();
    const other = await foreignTenantDocument();
    const mine = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    const app = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      const seen = await app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TID}, true)`;
        return tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "documents" WHERE "id" IN (${mine.id}, ${other.id})`;
      });
      expect(seen.map((r) => r.id)).toEqual([mine.id]);
    } finally {
      await app.$disconnect();
    }
  });

  it('the composite key refuses a previous-version link into another tenant', async () => {
    await setup();
    const other = await foreignTenantDocument();
    await expect(
      unscopedPrisma.document.create({
        data: {
          tenantId: TID,
          recordCode: `DOC-LINK-${suffix()}`,
          filename: 'link.pdf',
          storageKey: `tenants/${TID}/documents/${suffix()}`,
          mimeType: 'application/pdf',
          size: 4,
          attachedToType: 'contract',
          attachedToId: 'link',
          documentGroupId: `grp-${suffix()}`,
          contentSha256: sha256Hex(Buffer.from('link')),
          previousVersionId: other.id,
        },
      }),
    ).rejects.toThrow(/[Ff]oreign key/);
  });
});

describe('document store: hash', () => {
  it('refuses an upload whose bytes do not match the hash the caller declared, and writes nothing', async () => {
    await setup();
    const bytes = bodyOf('declared');
    const filename = `mismatch-${suffix()}.pdf`;
    const before = await countDocuments({ filename });
    const auditBefore = await countAudit('document');
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() =>
        documents.registerUpload(
          uploadInput({ filename, bytes, contentSha256: sha256Hex(Buffer.from('something else')) }),
        ),
      ),
    );
    expect(err.status).toBe(422);
    expect(await countDocuments({ filename })).toBe(before);
    expect(await countAudit('document')).toBe(auditBefore);
  });

  it('records the hash of the bytes it stored, and reads them back verified', async () => {
    await setup();
    const bytes = bodyOf('recorded');
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput({ bytes })));
    expect(doc.contentSha256).toBe(sha256Hex(bytes));
    expect(doc.size).toBe(bytes.length);
    const back = await asUser(CHAIRMAN, () => documents.readContent(doc.id));
    expect(back.equals(bytes)).toBe(true);
  });

  it('verifies the hash of a new version the same way, and refuses a mismatch with no new row', async () => {
    await setup();
    const v1 = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    const before = await countDocuments({ documentGroupId: v1.documentGroupId });
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() =>
        documents.addVersion({
          documentId: v1.id,
          bytes: bodyOf('v2'),
          contentSha256: sha256Hex(Buffer.from('not v2')),
        }),
      ),
    );
    expect(err.status).toBe(422);
    expect(await countDocuments({ documentGroupId: v1.documentGroupId })).toBe(before);
  });

  it('refuses to read content whose bytes no longer match the recorded hash', async () => {
    await setup();
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    writeFileSync(join(STORAGE_ROOT, doc.storageKey), Buffer.from('tampered after the fact'));
    const err = await asUser(CHAIRMAN, () => expectReject(() => documents.readContent(doc.id)));
    expect(err.message).toMatch(/hash/);
  });
});

describe('document store: version chain', () => {
  it('a new version links to the one before it, keeps the group, and counts up', async () => {
    await setup();
    const v1 = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    const v2 = await asUser(CHAIRMAN, () =>
      documents.addVersion({ documentId: v1.id, bytes: bodyOf('v2'), contentSha256: sha256Hex(bodyOf('v2')) }),
    );
    expect(v1.version).toBe(1);
    expect(v1.previousVersionId).toBeNull();
    expect(v2.version).toBe(2);
    expect(v2.previousVersionId).toBe(v1.id);
    expect(v2.documentGroupId).toBe(v1.documentGroupId);
    const v3 = await asUser(CHAIRMAN, () =>
      documents.addVersion({ documentId: v2.id, bytes: bodyOf('v3'), contentSha256: sha256Hex(bodyOf('v3')) }),
    );
    expect(v3.version).toBe(3);
    expect(v3.previousVersionId).toBe(v2.id);
  });

  it('refuses a second successor of a version that already has one (a fork)', async () => {
    await setup();
    const v1 = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    await asUser(CHAIRMAN, () =>
      documents.addVersion({ documentId: v1.id, bytes: bodyOf('head'), contentSha256: sha256Hex(bodyOf('head')) }),
    );
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() =>
        documents.addVersion({ documentId: v1.id, bytes: bodyOf('fork'), contentSha256: sha256Hex(bodyOf('fork')) }),
      ),
    );
    expect(err.status).toBe(409);
  });

  it('the database refuses two rows with the same version in one group', async () => {
    await setup();
    const v1 = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    await expect(
      unscopedPrisma.document.create({
        data: {
          tenantId: TID,
          recordCode: `DOC-DUP-${suffix()}`,
          filename: 'dup.pdf',
          storageKey: `tenants/${TID}/documents/${suffix()}`,
          mimeType: 'application/pdf',
          size: 4,
          attachedToType: 'contract',
          attachedToId: 'dup',
          documentGroupId: v1.documentGroupId,
          version: 1,
          contentSha256: sha256Hex(Buffer.from('dup')),
        },
      }),
    ).rejects.toThrow(/[Uu]nique/);
  });

  it('the content of a recorded version cannot change, whatever the role', async () => {
    await setup();
    const v1 = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    await expect(
      unscopedPrisma.document.update({ where: { id: v1.id }, data: { contentSha256: sha256Hex(Buffer.from('x')) } }),
    ).rejects.toThrow(/immutable/);
    await expect(unscopedPrisma.document.update({ where: { id: v1.id }, data: { storageKey: 'elsewhere' } })).rejects.toThrow(
      /immutable/,
    );
  });
});

describe('document store: lifecycle', () => {
  it('moves draft to active and active to archived, and records each move', async () => {
    await setup();
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    expect(doc.lifecycleStatus).toBe('draft');
    const active = await asUser(CHAIRMAN, () =>
      documents.changeLifecycleStatus({ documentId: doc.id, to: 'active', reason: 'Signed and filed.' }),
    );
    expect(active.lifecycleStatus).toBe('active');
    const archived = await asUser(CHAIRMAN, () =>
      documents.changeLifecycleStatus({ documentId: doc.id, to: 'archived', reason: 'Contract ended.' }),
    );
    expect(archived.lifecycleStatus).toBe('archived');
    expect(await countAudit('document', doc.id)).toBeGreaterThanOrEqual(3);
  });

  it('refuses every move the table does not allow, and leaves the status as it was', async () => {
    await setup();
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    const illegal: Array<[string, string]> = [
      ['draft', 'superseded'],
      ['active', 'draft'],
      ['archived', 'draft'],
      ['archived', 'active'],
    ];
    for (const [from, to] of illegal) {
      await unscopedPrisma.document.update({ where: { id: doc.id }, data: { lifecycleStatus: from } });
      const err = await asUser(CHAIRMAN, () =>
        expectReject(() => documents.changeLifecycleStatus({ documentId: doc.id, to: to as never, reason: 'Try it.' })),
      );
      expect(err.status, `${from} -> ${to}`).toBe(409);
      const after = await unscopedPrisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(after.lifecycleStatus, `${from} -> ${to}`).toBe(from);
    }
  });

  it('a superseded version cannot be activated again, and the writer refuses it', async () => {
    await setup();
    const v1 = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    await asUser(CHAIRMAN, () => documents.changeLifecycleStatus({ documentId: v1.id, to: 'active', reason: 'Filed.' }));
    const v2 = await asUser(CHAIRMAN, () =>
      documents.addVersion({ documentId: v1.id, bytes: bodyOf('v2'), contentSha256: sha256Hex(bodyOf('v2')) }),
    );
    await asUser(CHAIRMAN, () => documents.changeLifecycleStatus({ documentId: v2.id, to: 'active', reason: 'Amended.' }));
    const v1Now = await unscopedPrisma.document.findUniqueOrThrow({ where: { id: v1.id } });
    expect(v1Now.lifecycleStatus).toBe('superseded');
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() => documents.changeLifecycleStatus({ documentId: v1.id, to: 'active', reason: 'Revert.' })),
    );
    expect(err.status).toBe(409);
  });

  it('activating a version supersedes the active one in the same step, with an audit row and an event for it', async () => {
    await setup();
    const v1 = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    await asUser(CHAIRMAN, () => documents.changeLifecycleStatus({ documentId: v1.id, to: 'active', reason: 'Filed.' }));
    const v2 = await asUser(CHAIRMAN, () =>
      documents.addVersion({ documentId: v1.id, bytes: bodyOf('v2'), contentSha256: sha256Hex(bodyOf('v2')) }),
    );
    const supersededBefore = await countEvents(documents.DOCUMENT_EVENTS.SUPERSEDED);
    await asUser(CHAIRMAN, () => documents.changeLifecycleStatus({ documentId: v2.id, to: 'active', reason: 'Amended.' }));
    expect(await countEvents(documents.DOCUMENT_EVENTS.SUPERSEDED)).toBe(supersededBefore + 1);
    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: TID, subjectType: 'document', subjectId: v1.id, action: 'update' },
      orderBy: { seq: 'desc' },
    });
    expect(audit).not.toBeNull();
  });

  it('the database allows one active version per group, whatever the writer does', async () => {
    await setup();
    const v1 = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    const v2 = await asUser(CHAIRMAN, () =>
      documents.addVersion({ documentId: v1.id, bytes: bodyOf('v2'), contentSha256: sha256Hex(bodyOf('v2')) }),
    );
    await unscopedPrisma.document.update({ where: { id: v1.id }, data: { lifecycleStatus: 'active' } });
    await expect(
      unscopedPrisma.document.update({ where: { id: v2.id }, data: { lifecycleStatus: 'active' } }),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('refuses a status outside the four the store knows', async () => {
    await setup();
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    await expect(
      unscopedPrisma.document.update({ where: { id: doc.id }, data: { lifecycleStatus: 'deleted' } }),
    ).rejects.toThrow(/check|constraint/i);
  });
});

describe('document store: retention class', () => {
  it('refuses a class that no retention rule names, and sets one that has a rule', async () => {
    await setup();
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    const kind = `w6_kind_${suffix()}`;
    const none = await asUser(CHAIRMAN, () =>
      expectReject(() => documents.setRetentionClass({ documentId: doc.id, retentionClass: kind, reason: 'Keep it.' })),
    );
    expect(none.status).toBe(409);
    await unscopedPrisma.documentRetentionRule.create({
      data: { tenantId: TID, documentKind: kind, anchor: 'after_expiry', years: 8, effectiveFrom: new Date('2020-04-01T00:00:00.000Z') },
    });
    const set = await asUser(CHAIRMAN, () =>
      documents.setRetentionClass({ documentId: doc.id, retentionClass: kind, reason: 'Keep it.' }),
    );
    expect(set.retentionClass).toBe(kind);
  });
});

describe('document store: no delete path', () => {
  it('the application role cannot delete a document row', async () => {
    await setup();
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    const app = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${TID}, true)`;
          await tx.$executeRaw`DELETE FROM "documents" WHERE "id" = ${doc.id}`;
        }),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.$disconnect();
    }
    expect(await countDocuments({ id: doc.id })).toBe(1);
  });

  it('the owner role cannot delete a document row either: a trigger refuses it', async () => {
    await setup();
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput()));
    await expect(unscopedPrisma.document.delete({ where: { id: doc.id } })).rejects.toThrow(/immutable|archive/i);
    expect(await countDocuments({ id: doc.id })).toBe(1);
  });

  it('the module exports no delete-shaped operation, and the writer never calls a delete on the table', async () => {
    const exported = Object.keys(documents).filter((k) => /delete|remove|purge|destroy|erase/i.test(k));
    expect(exported).toEqual([]);
    const source = readFileSync(new URL('../domains/documents.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\.document\.(delete|deleteMany|upsert)\b/);
  });

  it('the routes mount no DELETE method for documents', async () => {
    const routes = readFileSync(new URL('../routes/documents.routes.ts', import.meta.url), 'utf8');
    expect(routes).not.toMatch(/\.delete\(/);
  });
});

describe('document store: permissions', () => {
  it('an own-scoped principal cannot register a document owned by somebody else, and writes nothing', async () => {
    await setup();
    const chairman = await principalFor(CHAIRMAN);
    const before = await countDocuments();
    const err = await asUser(EMPLOYEE, () =>
      expectReject(() => documents.registerUpload(uploadInput({ ownerPartyId: chairman.partyId }))),
    );
    expect(err.status).toBe(403);
    expect(await countDocuments()).toBe(before);
  });

  it('an own-scoped principal lists only the documents it owns', async () => {
    await setup();
    const mineName = `own-${suffix()}.pdf`;
    const employee = await principalFor(EMPLOYEE);
    const chairman = await principalFor(CHAIRMAN);
    const mine = await asUser(EMPLOYEE, () =>
      documents.registerUpload(uploadInput({ filename: mineName, ownerPartyId: employee.partyId })),
    );
    const theirs = await asUser(CHAIRMAN, () =>
      documents.registerUpload(uploadInput({ ownerPartyId: chairman.partyId })),
    );
    const listed = await asUser(EMPLOYEE, () => documents.listDocuments({}));
    expect(listed.map((d) => d.id)).toContain(mine.id);
    expect(listed.map((d) => d.id)).not.toContain(theirs.id);
  });
});

describe('document store: audit and event commit with the row', () => {
  it('a successful upload writes the row, one audit row and one event', async () => {
    await setup();
    const filename = `ok-${suffix()}.pdf`;
    const eventsBefore = await countEvents(documents.DOCUMENT_EVENTS.UPLOADED);
    const doc = await asUser(CHAIRMAN, () => documents.registerUpload(uploadInput({ filename })));
    expect(await countDocuments({ filename })).toBe(1);
    expect(await countAudit('document', doc.id)).toBe(1);
    expect(await countEvents(documents.DOCUMENT_EVENTS.UPLOADED)).toBe(eventsBefore + 1);
  });

  it('a failed audit row rolls back the document row, the event and the stored object', async () => {
    await setup();
    const filename = `audit-fail-${suffix()}.pdf`;
    const eventsBefore = await countEvents(documents.DOCUMENT_EVENTS.UPLOADED);
    const objectsBefore = storedObjects().length;
    await refuseDocumentAudit();
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() => documents.registerUpload(uploadInput({ filename }))),
    );
    expect(err.message).toMatch(INJECTED);
    expect(await countDocuments({ filename })).toBe(0);
    expect(await countEvents(documents.DOCUMENT_EVENTS.UPLOADED)).toBe(eventsBefore);
    expect(storedObjects().length).toBe(objectsBefore);
  });

  it('a failed event rolls back the document row and its audit row', async () => {
    await setup();
    const filename = `event-fail-${suffix()}.pdf`;
    const auditBefore = await countAudit('document');
    await refuseDocumentEvent();
    const err = await asUser(CHAIRMAN, () =>
      expectReject(() => documents.registerUpload(uploadInput({ filename }))),
    );
    expect(err.message).toMatch(INJECTED);
    expect(await countDocuments({ filename })).toBe(0);
    expect(await countAudit('document')).toBe(auditBefore);
  });

  it('every event name the module emits passes the grammar, and document is a governed entity', () => {
    for (const name of Object.values(documents.DOCUMENT_EVENTS)) {
      expect(isCanonicalEventName(name), name).toBe(true);
    }
    expect(isGoverned('document')).toBe(true);
  });
});
