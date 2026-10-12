/**
 * The API serves the built client itself when WEB_DIST_DIR is set, replacing
 * the Cloudflare Worker that used to do it.
 *
 * Two properties matter and they pull against each other. A client route such
 * as /people/employees must return index.html so the router can take it from
 * there. An unknown /api path must still return the JSON 404 the client
 * parses — if it returned index.html the client would see a 200 HTML page
 * where it expected an error envelope, and the failure would be silent.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';

const INDEX_HTML = '<!doctype html><html><body><div id="root">client shell</div></body></html>';

let dist: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'zen-web-dist-'));
  writeFileSync(join(dist, 'index.html'), INDEX_HTML);
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log("app");');

  const app = createApp({ webDistDir: dist });
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dist, { recursive: true, force: true });
});

describe('static client serving (WEB_DIST_DIR)', () => {
  it('returns index.html for a deep client route (SPA fallback)', async () => {
    const res = await fetch(`${base}/some/client/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('serves hashed assets from the dist directory', async () => {
    const res = await fetch(`${base}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toMatch(/immutable/);
  });

  it('gives index.html no-cache so a deploy is picked up on the next load', async () => {
    const res = await fetch(`${base}/people/employees`);
    expect(res.headers.get('cache-control')).toMatch(/no-cache/);
  });

  it('never answers an unknown /api path with index.html', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('answers a missing hashed asset with 404, not index.html', async () => {
    // A stale tab asking for a chunk from before the deploy must fail loudly;
    // HTML served as JavaScript fails with a parse error that points nowhere.
    const res = await fetch(`${base}/assets/gone-deadbeef.js`);
    expect(res.status).toBe(404);
  });
});
