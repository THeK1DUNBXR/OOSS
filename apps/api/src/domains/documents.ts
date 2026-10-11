/**
 * The document store (Wave 6 PR 2; CAP-DOC-01; SPINE-CONTRACT 1.3).
 *
 * One table, `Document`, holds every file the platform keeps as a file. A
 * version is a row: a new version links to the one it succeeds, and the chain
 * has one head per group. The bytes go to object storage (platform/objectStorage.ts);
 * the row carries the hash, so a changed object is detected on read.
 *
 * Every write is assertCan -> governedWrite (domain write, auditWrite, emit in
 * one transaction; CLAUDE.md rule 5). Nothing is deleted: a document leaves use
 * by being archived, and the database refuses a DELETE for every role.
 *
 * The rules the writer checks before the database does, so a refusal says what
 * is wrong: the hash, the successor of a version, the lifecycle table, the
 * retention class. The database keeps the same rules for any writer that skips
 * this module (migration 20261013090000_document_store).
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Document } from '@prisma/client';
import type { SensitivityClass } from '@kaizen/shared';
import { prisma, type DbTx } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan, matchNothing, scopeFor, scopeWhere } from '../platform/permissions.js';
import { auditWrite, registerGovernedEntities } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';
import { governedWrite } from '../platform/governedWrite.js';
import { nextRecordCode } from '../platform/recordCode.js';
import { activeObjectStorage, tenantKeyPrefix } from '../platform/objectStorage.js';

registerGovernedEntities('doc', ['document']);

/**
 * Event names. Past tense, and `kz.<domain>.<object>.<verb>` (CLAUDE.md rule 5).
 * `superseded` is emitted for the prior version, not for the one being
 * activated, so a subscriber that counts activations counts the right row.
 */
export const DOCUMENT_EVENTS = {
  UPLOADED: 'kz.doc.document.uploaded',
  VERSIONED: 'kz.doc.document.versioned',
  STATUS_CHANGED: 'kz.doc.document.status_changed',
  SUPERSEDED: 'kz.doc.document.superseded',
  RETENTION_CLASS_CHANGED: 'kz.doc.document.retention_class_changed',
} as const;

export const DOCUMENT_LIFECYCLE = ['draft', 'active', 'superseded', 'archived'] as const;
export type DocumentLifecycleStatus = (typeof DOCUMENT_LIFECYCLE)[number];

export const DOCUMENT_SOURCES = ['upload', 'import', 'generated'] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

/**
 * The moves a document may make. `superseded` is not a target here: a version
 * becomes superseded only when its successor is activated (in the same
 * transaction), so no row can reach it by a route of its own. Archived is final.
 */
export const DOCUMENT_TRANSITIONS: Readonly<Record<DocumentLifecycleStatus, readonly DocumentLifecycleStatus[]>> = {
  draft: ['active', 'archived'],
  active: ['archived'],
  superseded: ['archived'],
  archived: [],
};

/**
 * The ceiling an import already applies (imports/service.ts:33). A document
 * larger than this is a scan or a video, and belongs in a different store.
 */
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A retention class names a documentKind of DocumentRetentionRule: a lowercase code. */
const RETENTION_CLASS = /^[a-z][a-z0-9_]{1,40}$/;

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The bytes must be the bytes the caller says they are. The hash is checked
 * here, before anything is stored, so a wrong hash writes nothing at all.
 */
function verifyBytes(bytes: Buffer, declared: string): string {
  if (bytes.length === 0) throw ApiError.badRequest('The document has no content: the request body is empty.');
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw ApiError.badRequest(`A document is at most ${MAX_DOCUMENT_BYTES} bytes; this one is ${bytes.length}.`);
  }
  const claimed = declared.trim().toLowerCase();
  if (!SHA256_HEX.test(claimed)) {
    throw ApiError.badRequest('contentSha256 is the SHA-256 of the file, as 64 hexadecimal characters.');
  }
  if (sha256Hex(bytes) !== claimed) {
    throw ApiError.unprocessable('The bytes do not match the SHA-256 declared for them. Nothing was stored.');
  }
  return claimed;
}

function reasonOf(text: string): string {
  const note = text.trim();
  if (note.length < 3) throw ApiError.badRequest('Every change to a document states why it is made.');
  return note;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/**
 * A row by id, in this tenant. Another tenant's id is "not found", not
 * "forbidden": the caller learns nothing about whether the row exists.
 */
async function loadDocument(id: string): Promise<Document> {
  const row = await prisma.document.findFirst({ where: { id, tenantId: currentAuth().tenantId } });
  if (!row) throw ApiError.notFound('Document');
  return row;
}

/** The permission check for one document: the verb, held over its owner and its classification. */
async function guard(verb: 'view' | 'create' | 'edit', doc: Document): Promise<void> {
  await assertCan({
    resource: 'documents',
    verb,
    record: { ownerPartyId: doc.ownerPartyId },
    classification: doc.sensitivityClass as SensitivityClass,
  });
}

function objectKeyFor(tenantId: string, id: string): string {
  return `${tenantKeyPrefix(tenantId)}documents/${id}`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Everything a new row carries. The id is chosen here, because the key and the group are built from it. */
interface NewVersion {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  contentSha256: string;
  storageKey: string;
  attachedToType: string;
  attachedToId: string;
  documentGroupId: string;
  version: number;
  previousVersionId: string | null;
  documentKind: string;
  label: string | null;
  sensitivityClass: string;
  ownerPartyId: string | null;
  sourceType: DocumentSource;
  uploadedById: string | null;
}

/**
 * Writes the bytes and the row, with its audit row and event, as one unit.
 *
 * The object goes in first, inside the transaction, so a committed row always
 * has its bytes behind it. If anything after the put fails, the transaction
 * rolls back and the object is removed here, because nothing refers to it. A
 * failure before the put (a refused hash, say) never reaches this function.
 * `wrote` guards the removal: a put that failed because the key already existed
 * must not remove somebody else's object.
 */
async function insertVersion(
  row: NewVersion,
  bytes: Buffer,
  eventName: string,
  note: string | null,
): Promise<Document> {
  const auth = currentAuth();
  const storage = activeObjectStorage();
  let wrote = false;
  try {
    return await governedWrite(async (tx: DbTx) => {
      await storage.put(auth.tenantId, row.storageKey, bytes);
      wrote = true;
      const recordCode = await nextRecordCode('DOC', new Date(), tx);
      const created = await tx.document.create({
        data: { ...row, tenantId: auth.tenantId, recordCode, lifecycleStatus: 'draft' },
      });
      await auditWrite({
        action: 'create',
        subjectType: 'document',
        subjectId: created.id,
        after: {
          filename: created.filename,
          version: created.version,
          contentSha256: created.contentSha256,
          storageKey: created.storageKey,
          lifecycleStatus: 'draft',
          ownerPartyId: created.ownerPartyId,
        },
        meta: note ? { reason: note } : undefined,
        tx,
      });
      await emit({
        name: eventName,
        subject: { entityType: 'document', entityId: created.id, recordCode },
        newState: {
          version: created.version,
          previousVersionId: created.previousVersionId,
          contentSha256: created.contentSha256,
          lifecycleStatus: 'draft',
        },
        reason: note ? { note } : null,
        tx,
      });
      return created;
    });
  } catch (err) {
    if (wrote) await storage.discard(auth.tenantId, row.storageKey).catch(() => undefined);
    if (isUniqueViolation(err)) {
      throw ApiError.conflict('Another change to this document group landed first. Read it again and retry.');
    }
    throw err;
  }
}

export interface RegisterUploadInput {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  /** SHA-256 of `bytes`, as the caller computed it. Verified here before anything is stored. */
  contentSha256: string;
  attachedToType: string;
  attachedToId: string;
  /** The person the document belongs to. Defaults to the caller; an agent must name one. */
  ownerPartyId?: string | null;
  sensitivityClass?: string;
  documentKind?: string;
  label?: string | null;
  sourceType?: DocumentSource;
}

/** A first version. It starts as a draft: nothing is in force until it is activated. */
export async function registerUpload(input: RegisterUploadInput): Promise<Document> {
  const auth = currentAuth();
  const owner = input.ownerPartyId ?? auth.partyId ?? null;
  if (!owner) throw ApiError.unprocessable('A document needs an owner: name the person it belongs to.');
  const filename = input.filename.trim();
  if (filename.length === 0 || filename.length > 255) {
    throw ApiError.badRequest('A document has a file name, at most 255 characters.');
  }
  const sensitivityClass = input.sensitivityClass ?? 'internal';
  await assertCan({
    resource: 'documents',
    verb: 'create',
    record: { ownerPartyId: owner },
    classification: sensitivityClass as SensitivityClass,
  });
  const hash = verifyBytes(input.bytes, input.contentSha256);
  const id = randomUUID();
  return insertVersion(
    {
      id,
      filename,
      mimeType: input.mimeType,
      size: input.bytes.length,
      contentSha256: hash,
      storageKey: objectKeyFor(auth.tenantId, id),
      attachedToType: input.attachedToType,
      attachedToId: input.attachedToId,
      documentGroupId: id,
      version: 1,
      previousVersionId: null,
      documentKind: input.documentKind ?? 'file_artefact',
      label: input.label ?? null,
      sensitivityClass,
      ownerPartyId: owner,
      sourceType: input.sourceType ?? 'upload',
      uploadedById: auth.userId ?? null,
    },
    input.bytes,
    DOCUMENT_EVENTS.UPLOADED,
    null,
  );
}

export interface AddVersionInput {
  documentId: string;
  bytes: Buffer;
  contentSha256: string;
  label?: string | null;
}

/**
 * The next version of a document. It succeeds the version named, which must be
 * the head: a version with a successor already has one, and a second would be
 * a fork. The new version carries the prior one's identity and starts as a draft.
 */
export async function addVersion(input: AddVersionInput): Promise<Document> {
  const auth = currentAuth();
  const prior = await loadDocument(input.documentId);
  await guard('create', prior);
  const hash = verifyBytes(input.bytes, input.contentSha256);
  const successor = await prisma.document.findFirst({
    where: { tenantId: auth.tenantId, previousVersionId: prior.id },
    select: { id: true, version: true },
  });
  if (successor) {
    throw ApiError.conflict(
      `Version ${prior.version} already has a successor (version ${successor.version}). Add the new version to that one.`,
    );
  }
  const id = randomUUID();
  return insertVersion(
    {
      id,
      filename: prior.filename,
      mimeType: prior.mimeType,
      size: input.bytes.length,
      contentSha256: hash,
      storageKey: objectKeyFor(auth.tenantId, id),
      attachedToType: prior.attachedToType,
      attachedToId: prior.attachedToId,
      documentGroupId: prior.documentGroupId,
      version: prior.version + 1,
      previousVersionId: prior.id,
      documentKind: prior.documentKind,
      label: input.label ?? prior.label,
      sensitivityClass: prior.sensitivityClass,
      ownerPartyId: prior.ownerPartyId,
      sourceType: prior.sourceType as DocumentSource,
      uploadedById: auth.userId ?? null,
    },
    input.bytes,
    DOCUMENT_EVENTS.VERSIONED,
    null,
  );
}

/** One status move on one row, conditional on the status it was read in, so a racing move matches no row. */
async function moveStatus(
  tx: DbTx,
  doc: Document,
  to: DocumentLifecycleStatus,
  note: string,
  eventName: string,
): Promise<Document> {
  const tenantId = currentAuth().tenantId;
  const from = doc.lifecycleStatus;
  const { count } = await tx.document.updateMany({
    where: { id: doc.id, tenantId, lifecycleStatus: from },
    data: { lifecycleStatus: to },
  });
  if (count !== 1) throw ApiError.conflict('This document changed while it was being updated. Read it again.');
  const after = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
  await auditWrite({
    action: 'update',
    subjectType: 'document',
    subjectId: doc.id,
    before: { lifecycleStatus: from },
    after: { lifecycleStatus: to },
    meta: { reason: note },
    tx,
  });
  await emit({
    name: eventName,
    subject: { entityType: 'document', entityId: doc.id, recordCode: doc.recordCode },
    previousState: { lifecycleStatus: from },
    newState: { lifecycleStatus: to },
    reason: { note },
    tx,
  });
  return after;
}

export interface ChangeLifecycleInput {
  documentId: string;
  to: DocumentLifecycleStatus;
  reason: string;
}

/**
 * Activating a version supersedes the one in force, in the same transaction.
 * The prior version moves first: the partial unique index allows one active
 * version per group, so the order is what keeps the index from refusing the
 * activation.
 */
export async function changeLifecycleStatus(input: ChangeLifecycleInput): Promise<Document> {
  const note = reasonOf(input.reason);
  const doc = await loadDocument(input.documentId);
  await guard('edit', doc);
  if (!(DOCUMENT_LIFECYCLE as readonly string[]).includes(input.to)) {
    throw ApiError.badRequest(
      `"${input.to}" is not a lifecycle status. Expected one of: ${DOCUMENT_LIFECYCLE.join(', ')}.`,
    );
  }
  if (input.to === 'superseded') {
    throw ApiError.conflict('A version is superseded when its successor is activated, not by hand.');
  }
  const from = doc.lifecycleStatus as DocumentLifecycleStatus;
  if (!DOCUMENT_TRANSITIONS[from].includes(input.to)) {
    throw ApiError.conflict(`A ${from} document cannot become ${input.to}.`);
  }
  const tenantId = currentAuth().tenantId;
  try {
    return await governedWrite(async (tx: DbTx) => {
      if (input.to === 'active') {
        const inForce = await tx.document.findFirst({
          where: { tenantId, documentGroupId: doc.documentGroupId, lifecycleStatus: 'active', id: { not: doc.id } },
        });
        if (inForce) {
          await moveStatus(tx, inForce, 'superseded', note, DOCUMENT_EVENTS.SUPERSEDED);
        }
      }
      return moveStatus(tx, doc, input.to, note, DOCUMENT_EVENTS.STATUS_CHANGED);
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw ApiError.conflict('Another version of this document was activated first. Read it again and retry.');
    }
    throw err;
  }
}

export interface SetRetentionInput {
  documentId: string;
  /** A documentKind of DocumentRetentionRule, or null to clear the class. */
  retentionClass: string | null;
  reason: string;
}

/**
 * Sets the retention class. The class must name a dated DocumentRetentionRule
 * already in force: the years live in that rule, so a class with no rule would
 * be a retention period nobody had written down (CLAUDE.md rule 4).
 */
export async function setRetentionClass(input: SetRetentionInput): Promise<Document> {
  const note = reasonOf(input.reason);
  const doc = await loadDocument(input.documentId);
  await guard('edit', doc);
  const tenantId = currentAuth().tenantId;
  const next = input.retentionClass === null ? null : input.retentionClass.trim();
  if (next !== null) {
    if (!RETENTION_CLASS.test(next)) {
      throw ApiError.badRequest('A retention class is a lowercase code, such as hr_files.');
    }
    const rule = await prisma.documentRetentionRule.findFirst({
      where: { tenantId, documentKind: next, effectiveFrom: { lte: new Date() } },
      select: { id: true },
    });
    if (!rule) {
      throw ApiError.conflict(
        `No retention rule covers "${next}". Add a dated rule for that kind first; the years are read from the rule, not stored on the document.`,
      );
    }
  }
  if (next === doc.retentionClass) return doc;
  return governedWrite(async (tx: DbTx) => {
    const { count } = await tx.document.updateMany({
      where: { id: doc.id, tenantId, retentionClass: doc.retentionClass },
      data: { retentionClass: next },
    });
    if (count !== 1) throw ApiError.conflict('This document changed while it was being updated. Read it again.');
    const after = await tx.document.findUniqueOrThrow({ where: { id: doc.id } });
    await auditWrite({
      action: 'update',
      subjectType: 'document',
      subjectId: doc.id,
      before: { retentionClass: doc.retentionClass },
      after: { retentionClass: next },
      meta: { reason: note },
      tx,
    });
    await emit({
      name: DOCUMENT_EVENTS.RETENTION_CLASS_CHANGED,
      subject: { entityType: 'document', entityId: doc.id, recordCode: doc.recordCode },
      previousState: { retentionClass: doc.retentionClass },
      newState: { retentionClass: next },
      reason: { note },
      tx,
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getDocument(id: string): Promise<Document> {
  const doc = await loadDocument(id);
  await guard('view', doc);
  return doc;
}

export interface DocumentFilter {
  attachedToType?: string;
  attachedToId?: string;
  lifecycleStatus?: DocumentLifecycleStatus;
  limit?: number;
}

/**
 * The documents the caller may see. Narrowed by the caller's scope on the owner,
 * the way every owned list is, and fail-closed when no grant resolves.
 */
export async function listDocuments(filter: DocumentFilter = {}): Promise<Document[]> {
  const auth = currentAuth();
  await assertCan({ resource: 'documents', verb: 'view' });
  const scope = await scopeFor('documents', 'view');
  const scoped = scope ? scopeWhere(scope, auth, 'ownerPartyId') : matchNothing('ownerPartyId');
  return prisma.document.findMany({
    where: {
      tenantId: auth.tenantId,
      ...scoped,
      ...(filter.attachedToType ? { attachedToType: filter.attachedToType } : {}),
      ...(filter.attachedToId ? { attachedToId: filter.attachedToId } : {}),
      ...(filter.lifecycleStatus ? { lifecycleStatus: filter.lifecycleStatus } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(filter.limit ?? 100, 200),
  });
}

/**
 * The bytes of a version, verified. The hash is recomputed here: a file that
 * changed after it was stored is reported as an error, never handed back as if
 * it were the document.
 */
export async function readContent(documentId: string): Promise<Buffer> {
  const doc = await loadDocument(documentId);
  await guard('view', doc);
  const bytes = await activeObjectStorage().get(doc.tenantId, doc.storageKey);
  if (sha256Hex(bytes) !== doc.contentSha256) {
    throw ApiError.internal(
      'The stored content does not match the hash recorded for it: the object changed after it was stored.',
    );
  }
  return bytes;
}
