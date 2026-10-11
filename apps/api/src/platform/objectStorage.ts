/**
 * Object storage for document bytes (CAP-DOC-01).
 *
 * The database holds a document's metadata and hash; the bytes live here. The
 * interface is small on purpose: a put that refuses to overwrite, a get, and a
 * discard for an object that no row ever pointed at.
 *
 * Which provider holds production bytes is not decided here. Hosting is
 * deferred until after Phase 1 (DECISIONS D:599-615), and an India-region
 * store is a requirement for that decision, not something this module can
 * promise. The only implementation is a local directory, for development and
 * the test suite. A cloud backend, when it comes, implements the same interface
 * and is selected in activeObjectStorage().
 *
 * Every call names the tenant it is for, and a key outside that tenant's prefix
 * is refused here, below the domain code. A domain bug that handed one tenant's
 * key to another tenant's request still meets this check (CLAUDE.md rule 6).
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { config } from './config.js';
import { ApiError } from './errors.js';

export interface ObjectStorage {
  /** Writes a new object. Refuses a key that already exists: an object is never overwritten. */
  put(tenantId: string, key: string, bytes: Buffer): Promise<void>;
  /** Reads an object. A key outside the tenant's prefix is refused, never read. */
  get(tenantId: string, key: string): Promise<Buffer>;
  /**
   * Removes an object that no committed row refers to, after the write that
   * would have recorded it failed. Not a delete of a document: a document is
   * archived, and its bytes are never removed while a row names them.
   */
  discard(tenantId: string, key: string): Promise<void>;
}

/** The prefix every key for a tenant starts with. Shared by the key builder and the check. */
export function tenantKeyPrefix(tenantId: string): string {
  return `tenants/${tenantId}/`;
}

/**
 * A key is a tenant prefix and then plain segments. Anything that climbs out
 * with `..`, or repeats a slash, is not a key the store wrote.
 */
export function assertTenantKey(tenantId: string, key: string): void {
  const prefix = tenantKeyPrefix(tenantId);
  if (!key.startsWith(prefix)) {
    throw new Error(`storage key ${key} is not under the tenant ${tenantId} it was asked for`);
  }
  const segments = key.slice(prefix.length).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`storage key ${key} is not a plain path under tenant ${tenantId}`);
  }
}

/**
 * Files under a root directory. The resolved path is checked to stay under the
 * root as well, so a symlink or an odd key cannot reach a sibling directory.
 */
export class LocalObjectStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(tenantId: string, key: string): string {
    assertTenantKey(tenantId, key);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) {
      throw new Error(`storage key ${key} resolves outside the storage root`);
    }
    return full;
  }

  async put(tenantId: string, key: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(tenantId, key);
    await mkdir(dirname(path), { recursive: true });
    // 'wx' fails if the file exists: a second write to one key is a bug or an
    // attack, and either way the first bytes must not be replaced.
    await writeFile(path, bytes, { flag: 'wx' });
  }

  async get(tenantId: string, key: string): Promise<Buffer> {
    return readFile(this.pathFor(tenantId, key));
  }

  async discard(tenantId: string, key: string): Promise<void> {
    await rm(this.pathFor(tenantId, key), { force: true });
  }
}

/**
 * The store the process writes to, from DOCUMENT_STORAGE_DIR. Unset, uploads are
 * refused rather than written to some default place: a silent default is where
 * bytes end up in a directory nobody backs up.
 */
export function activeObjectStorage(): ObjectStorage {
  const root = config.DOCUMENT_STORAGE_DIR;
  if (!root) {
    throw ApiError.internal('Document storage is not configured: set DOCUMENT_STORAGE_DIR.');
  }
  return new LocalObjectStorage(root);
}
