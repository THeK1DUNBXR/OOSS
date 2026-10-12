/**
 * G12, accessibility by Lighthouse (CI-GATES-DRAFT G12; owner answer, round 11).
 *
 * Runs Lighthouse's accessibility category against the built client, served by
 * the built API on one origin, and fails if any page scores below the threshold.
 *
 * Lighthouse attaches to a Chromium this script starts, over its remote-debugging
 * port. The browser is a persistent profile, so the session the sign-in writes
 * is the one Lighthouse's own tabs load with. A signed-in page signs in again
 * first: each sign-in is one login for the account, and a session that was just
 * rotated by a page that closed is not reused (see e2e/tests/helpers.ts,
 * settleSession).
 *
 *   E2E_BASE_URL   the origin serving both the client and /api  (default http://127.0.0.1:4000)
 *   E2E_EMAIL / E2E_PASSWORD (or OWNER_EMAIL / OWNER_PASSWORD)  the seeded owner account
 *   LH_MIN_SCORE   the threshold, 0 to 100                      (default 95)
 *   LH_REPORT_DIR  where the JSON reports go, if set
 *   LH_PLANTED_URL a single unauthenticated URL to run instead of the app pages;
 *                  used to show the threshold fails on a page that violates it
 */

import { chromium } from '@playwright/test';
import lighthouse, { desktopConfig } from 'lighthouse';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4000';
const MIN = Number(process.env.LH_MIN_SCORE ?? 95);
const DEBUG_PORT = Number(process.env.LH_DEBUG_PORT ?? 9222);
const REPORT_DIR = process.env.LH_REPORT_DIR;
const PLANTED = process.env.LH_PLANTED_URL;

/** The sign-in screen, then the main signed-in screens a person lands on. */
const APP_PAGES = [
  { name: 'sign-in', path: '/', signedIn: false },
  { name: 'command centre', path: '/command', signedIn: true },
  { name: 'workspace', path: '/workspace', signedIn: true },
  { name: 'decisions', path: '/command/decisions', signedIn: true },
];

function credentials() {
  const email = process.env.E2E_EMAIL ?? process.env.OWNER_EMAIL;
  const password = process.env.E2E_PASSWORD ?? process.env.OWNER_PASSWORD;
  if (!email || !password) throw new Error('Set E2E_EMAIL and E2E_PASSWORD (or OWNER_EMAIL and OWNER_PASSWORD).');
  return { email, password };
}

/** The API's login, through the browser's own cookie jar, as the app's sign-in does. */
async function signIn(page) {
  const { email, password } = credentials();
  await page.context().clearCookies();
  const res = await page.request.post(`${BASE}/api/auth/login`, { data: { email, password } });
  const body = await res.text();
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()} ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  if (json.mfaRequired || !json.token) throw new Error('sign-in did not start a session (MFA or no token)');
  await page.goto(`${BASE}/`);
  // Same flag the e2e helpers set: the one-off orientation modal, dismissed as a user would.
  await page.evaluate("window.localStorage.setItem('kaizen.seenIntro', '1')");
  await page.goto(`${BASE}/`);
  await page.getByRole('link', { name: 'Getting Started' }).waitFor({ state: 'visible', timeout: 30_000 });
}

/** One Lighthouse accessibility run; returns the score and the audits that did not pass. */
async function measure(url, name) {
  const flags = {
    port: DEBUG_PORT,
    output: 'json',
    onlyCategories: ['accessibility'],
    logLevel: 'error',
    // The session cookie is the sign-in. Lighthouse's default storage reset would clear it.
    disableStorageReset: true,
  };
  const { lhr } = await lighthouse(url, flags, desktopConfig);
  const score = Math.round((lhr.categories.accessibility.score ?? 0) * 100);
  const failing = Object.values(lhr.audits)
    .filter(
      (a) =>
        a.score !== null && a.score < 1 && a.scoreDisplayMode !== 'notApplicable' && a.scoreDisplayMode !== 'manual',
    )
    .map((a) => ({ id: a.id, title: a.title, items: a.details?.items?.length ?? 0 }));
  if (REPORT_DIR) {
    await mkdir(REPORT_DIR, { recursive: true });
    await writeFile(join(REPORT_DIR, `${name.replace(/\W+/g, '-')}.json`), JSON.stringify(lhr, null, 2));
  }
  return { name, url, score, failing };
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'kaizen-lighthouse-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    args: [`--remote-debugging-port=${DEBUG_PORT}`],
  });
  const results = [];
  try {
    if (PLANTED) {
      results.push(await measure(PLANTED, 'planted'));
    } else {
      const page = context.pages()[0] ?? (await context.newPage());
      for (const target of APP_PAGES) {
        if (target.signedIn) await signIn(page);
        else await context.clearCookies();
        results.push(await measure(`${BASE}${target.path}`, target.name));
      }
    }
  } finally {
    await context.close();
  }

  let failed = false;
  for (const r of results) {
    const ok = r.score >= MIN;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  accessibility ${r.score}  (min ${MIN})  ${r.name}  ${r.url}`);
    for (const a of r.failing)
      console.log(`        - ${a.id}: ${a.title} (${a.items} item${a.items === 1 ? '' : 's'})`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
