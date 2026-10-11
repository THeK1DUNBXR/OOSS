/**
 * What every browser test needs before it can look at anything: a way in, and
 * the checklist the app is being asked about.
 */

import { devices, expect, test as base, type BrowserContext, type Page, type Request } from '@playwright/test';

export const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:4000';

/** A step of the getting-started checklist, as `/api/auth/onboarding` returns it. */
export interface OnboardingStep {
  key: string;
  title: string;
  why: string;
  done: boolean;
  count: number;
  /** The screen the step lives on. */
  path: string;
  /** Where the step is actually performed, when that is not merely the screen. */
  doPath?: string;
  action: string;
  optional?: boolean;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  done: number;
  total: number;
  complete: boolean;
}

/**
 * Where a step's button ought to take you.
 *
 * An undone step is a job to do, so it goes wherever the job is done; a done
 * step is something to look at, so it goes to the screen. This is the rule the
 * client is expected to follow, written once here so a test can hold the client
 * to it rather than restating whatever the client happens to do.
 */
export function destinationOf(step: OnboardingStep): string {
  return step.done ? step.path : (step.doPath ?? step.path);
}

/**
 * One browser context for the whole worker, and a fresh page per test in it.
 *
 * The session lives in the httpOnly refresh cookie, and the API rotates that
 * cookie on every use. A context per test would need a new sign-in per test,
 * and the login route allows five a minute per email (`rateLimit.ts`), which
 * the suite passes in under a minute. Sharing the context means one sign-in
 * per account, and the browser's own cookie jar carries the rotated cookie from
 * one test to the next, as it would for a person who keeps the tab open.
 */
export const test = base.extend<object, { sharedContext: BrowserContext }>({
  sharedContext: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext({
        ...devices['Desktop Chrome'],
        baseURL: workerInfo.project.use.baseURL,
      });
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],
  page: async ({ sharedContext }, use) => {
    const page = await sharedContext.newPage();
    await use(page);
    await page.close();
  },
});

function credentials(): { email: string; password: string } {
  const email = process.env.E2E_EMAIL ?? process.env.OWNER_EMAIL;
  const password = process.env.E2E_PASSWORD ?? process.env.OWNER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'These tests sign in as a real account. Set E2E_EMAIL and E2E_PASSWORD (or OWNER_EMAIL and ' +
        'OWNER_PASSWORD, the names the seed reads) to an account on the running stack. The seed prints ' +
        'each generated password once and keeps it nowhere, so set OWNER_PASSWORD before seeding if you ' +
        'want to know it afterwards.',
    );
  }
  return { email, password };
}

/** Sign in as the default test account, the way a person does. */
export async function signIn(page: Page): Promise<void> {
  const { email, password } = credentials();
  await signInAs(page, email, password);
}

/** The account the shared context is signed in as, if any. */
let signedInAs: string | null = null;

/** The account each page was signed in as, for the API calls a test makes on its behalf. */
const accountOf = new WeakMap<Page, string>();

/** The session renewals each page has in flight. See `settleSession`. */
const renewalsInFlight = new WeakMap<Page, Set<Request>>();

/** Records a page's session renewals while they are in flight. */
function trackRenewals(page: Page): void {
  const inFlight = new Set<Request>();
  renewalsInFlight.set(page, inFlight);
  const isRenewal = (r: Request) => r.url().includes('/api/auth/refresh');
  page.on('request', (r) => {
    if (isRenewal(r)) inFlight.add(r);
  });
  const finished = (r: Request) => inFlight.delete(r);
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
}

/**
 * Waits until the page has no session renewal in flight.
 *
 * A renewal rotates the refresh cookie on the server before its response
 * reaches the browser. If the page navigates away first, the response is
 * dropped with the page, and the browser keeps the old cookie. The server
 * accepts that old cookie only for its grace window, so the next renewal after
 * that is refused and the app shows the sign-in screen. A person does not
 * navigate while the app is still renewing, so the test does not either.
 */
export async function settleSession(page: Page): Promise<void> {
  const inFlight = renewalsInFlight.get(page);
  if (!inFlight) return;
  await expect.poll(() => inFlight.size, { message: 'a session renewal never finished' }).toBe(0);
}

/**
 * Signs the shared browser context in the way the app itself does, then opens
 * the page at `/` and lets the app restore the session.
 *
 * Since 0.2 the access token lives only in the page's memory, and the session
 * is carried by the httpOnly `kz_refresh` cookie that `/api/auth/login` sets.
 * `page.request` shares its cookie jar with the page's browser context, so the
 * login below leaves the cookie where `restoreSession()` finds it when the app
 * loads. Nothing is written to localStorage: the app clears any token stored
 * there, so a test that put one there would be testing a session the app does
 * not have.
 *
 * A second sign-in as the same account in the same run reuses that session
 * rather than logging in again (see `test` above). Switching accounts clears
 * the cookie first, so the new session cannot be mistaken for the old one.
 */
export async function signInAs(page: Page, email: string, password: string): Promise<void> {
  accountOf.set(page, email);
  trackRenewals(page);

  // The one-off orientation modal, dismissed as a user would dismiss it once.
  // A per-browser convenience flag, not part of the session.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('kaizen.seenIntro', '1');
    } catch {
      /* a browser without storage shows the modal; nothing to do */
    }
  });

  if (signedInAs === email) {
    await page.goto('/');
    if (await shellShows(page)) {
      await settleSession(page);
      return;
    }
    // The cookie this browser holds no longer restores. A renewal can be lost
    // when the page that made it is closed before the response is stored, and
    // the server has rotated past the cookie the browser kept. Sign in again,
    // which is what a person would do at the sign-in screen.
  }

  await page.context().clearCookies();
  const login = await page.request.post(`${API_URL}/api/auth/login`, { data: { email, password } });
  const body = await login.text();
  if (!login.ok()) {
    throw new Error(`signing in as ${email} at ${API_URL} failed: ${login.status()} ${body}`);
  }
  const json = JSON.parse(body) as { token?: string; mfaRequired?: boolean };
  if (json.mfaRequired || !json.token) {
    throw new Error(
      `signing in as ${email} did not start a session (` +
        (json.mfaRequired ? 'a second factor is required' : 'no access token in the response') +
        '). The e2e accounts must have no MFA enrolled and must belong to exactly one entity.',
    );
  }
  signedInAs = email;

  await page.goto('/');

  // The landing screen depends on the role, so wait for the shell rather than
  // for a path: every signed-in person has the sidebar and nobody else does.
  await expect(page.getByRole('link', { name: 'Getting Started' })).toBeVisible();
  await settleSession(page);
}

/** Whether the signed-in shell appears, within a few seconds of the page loading. */
async function shellShows(page: Page): Promise<boolean> {
  return page
    .getByRole('link', { name: 'Getting Started' })
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
}

/**
 * The checklist as the server computes it, read straight from the API.
 *
 * Not scraped off the page: these tests exist to compare what the screen does
 * against what the server said, and a screen cannot be both the question and
 * the answer. The page must have been signed in with `signIn` or `signInAs`.
 *
 * The API wants a bearer token, and the page's own token is in memory where a
 * test cannot read it. The refresh route issues one from the same cookie the
 * app uses, and the rotated cookie lands in the shared jar for the next load.
 */
export async function onboardingState(page: Page): Promise<OnboardingState> {
  if (!accountOf.has(page)) {
    throw new Error('onboardingState needs a page that was signed in with signIn or signInAs first');
  }

  const refreshed = await page.request.post(`${API_URL}/api/auth/refresh`);
  const refreshBody = await refreshed.text();
  if (!refreshed.ok()) throw new Error(`renewing the session failed: ${refreshed.status()} ${refreshBody}`);
  const { token } = JSON.parse(refreshBody) as { token?: string };
  if (!token) throw new Error(`renewing the session returned no access token: ${refreshBody}`);

  const res = await page.request.get(`${API_URL}/api/auth/onboarding`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.text();
  if (!res.ok()) throw new Error(`reading the checklist failed: ${res.status()} ${body}`);
  return JSON.parse(body) as OnboardingState;
}

/** The path part of a URL, which is what a navigation assertion is actually about. */
export function pathOf(url: string, base = 'http://127.0.0.1'): string {
  return new URL(url, base).pathname;
}
