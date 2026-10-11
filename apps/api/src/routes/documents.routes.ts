/**
 * Document endpoints (domains/documents.ts). Every permission check is in the
 * domain; the routes parse and hand over, and map nothing themselves.
 *
 * An upload sends the file as the raw body, as the imports endpoint does: the
 * bytes are not re-encoded and the server does not need a parser for them. The
 * metadata (file name, hash, what it is attached to) rides in one header as
 * base64url JSON, because the body is the bytes and a header would otherwise
 * have to carry a non-ASCII file name in an encoding of its own.
 *
 * There is no DELETE route. A document leaves use by being archived.
 */

import { Router, raw } from 'express';
import { z } from 'zod';
import { handler } from '../lib/http.js';
import { ApiError } from '../platform/errors.js';
import {
  DOCUMENT_LIFECYCLE,
  DOCUMENT_SOURCES,
  MAX_DOCUMENT_BYTES,
  addVersion,
  changeLifecycleStatus,
  getDocument,
  listDocuments,
  registerUpload,
  setRetentionClass,
} from '../domains/documents.js';

const router = Router();

const uploadMeta = z
  .object({
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(127),
    contentSha256: z.string().length(64),
    attachedToType: z.string().min(1).max(64),
    attachedToId: z.string().min(1).max(128),
    ownerPartyId: z.string().min(1).max(128).optional(),
    sensitivityClass: z.string().min(1).max(32).optional(),
    documentKind: z.string().min(1).max(64).optional(),
    label: z.string().max(200).optional(),
    sourceType: z.enum(DOCUMENT_SOURCES).optional(),
  })
  .strict();

const versionMeta = z
  .object({
    contentSha256: z.string().length(64),
    label: z.string().max(200).optional(),
  })
  .strict();

const lifecycleBody = z
  .object({
    to: z.enum(DOCUMENT_LIFECYCLE),
    reason: z.string().min(3).max(500),
  })
  .strict();

const retentionBody = z
  .object({
    retentionClass: z.string().min(2).max(41).nullable(),
    reason: z.string().min(3).max(500),
  })
  .strict();

const listQuery = z.object({
  attachedToType: z.string().min(1).max(64).optional(),
  attachedToId: z.string().min(1).max(128).optional(),
  lifecycleStatus: z.enum(DOCUMENT_LIFECYCLE).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

/** The metadata header, decoded and validated. A missing or malformed one is the caller's error. */
function metaFrom<T extends z.ZodTypeAny>(req: { header(name: string): string | undefined }, schema: T): z.infer<T> {
  const encoded = req.header('x-document-meta');
  if (!encoded) {
    throw ApiError.badRequest('Send the metadata in the X-Document-Meta header: base64url-encoded JSON.');
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw ApiError.badRequest('X-Document-Meta is not base64url-encoded JSON.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw ApiError.badRequest(
      `Document metadata is not valid: ${parsed.error.issues.map((i) => i.path.join('.') || 'body').join(', ')}.`,
    );
  }
  return parsed.data;
}

function bodyOf(req: { body?: unknown }): Buffer {
  const body = req.body as Buffer | undefined;
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw ApiError.badRequest('No file arrived. Send the file as the request body.');
  }
  return body;
}

router.get(
  '/',
  handler(async (req) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) throw ApiError.badRequest('The list filter is not valid.');
    return { items: await listDocuments(q.data) };
  }),
);

router.get(
  '/:id',
  handler(async (req) => getDocument(req.params.id)),
);

router.post(
  '/',
  raw({ type: '*/*', limit: MAX_DOCUMENT_BYTES }),
  handler(async (req) => {
    const meta = metaFrom(req, uploadMeta);
    return registerUpload({ ...meta, bytes: bodyOf(req) });
  }),
);

router.post(
  '/:id/versions',
  raw({ type: '*/*', limit: MAX_DOCUMENT_BYTES }),
  handler(async (req) => {
    const meta = metaFrom(req, versionMeta);
    return addVersion({ documentId: req.params.id, bytes: bodyOf(req), ...meta });
  }),
);

router.post(
  '/:id/lifecycle',
  handler(async (req) => {
    const parsed = lifecycleBody.safeParse(req.body);
    if (!parsed.success)
      throw ApiError.badRequest('A lifecycle change names a status and a reason of at least 3 characters.');
    return changeLifecycleStatus({ documentId: req.params.id, ...parsed.data });
  }),
);

router.post(
  '/:id/retention',
  handler(async (req) => {
    const parsed = retentionBody.safeParse(req.body);
    if (!parsed.success)
      throw ApiError.badRequest('A retention change names a class (or null) and a reason of at least 3 characters.');
    return setRetentionClass({ documentId: req.params.id, ...parsed.data });
  }),
);

export default router;
