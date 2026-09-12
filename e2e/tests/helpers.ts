/**
 * What every browser test needs before it can look at anything: a way in, and
 * the checklist the app is being asked about.
 */

import { expect, type APIRequestContext, type Page } from '@playwright/test';

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

/** Sign in through the form, the way a person does. */
export async function signIn(page: Page): Promise<void> {
  const { email, password } = credentials();

  // The one-off orientation modal covers the screen on a first visit. It is
  // dismissed by hand once by a real user and would otherwise be dismissed by
  // hand in every test here.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('kaizen.seenIntro', '1');
    } catch {
      /* a browser without storage still shows the modal; nothing to do */
    }
  });

  await page.goto('/');
  // The sign-in form's labels are not wired to their inputs, so the fields are
  // found by type rather than by name. Worth fixing in the client one day; not
  // worth failing this suite over in the meantime.
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The landing screen depends on the role, so wait for the shell rather than
  // for a path: every signed-in person has the sidebar and nobody else does.
  await expect(page.getByRole('link', { name: 'Getting Started' })).toBeVisible();
}

/**
 * The checklist as the server computes it, read straight from the API.
 *
 * Not scraped off the page: these tests exist to compare what the screen does
 * against what the server said, and a screen cannot be both the question and
 * the answer.
 */
export async function onboardingState(request: APIRequestContext): Promise<OnboardingState> {
  const { email, password } = credentials();
  const login = await request.post(`${API_URL}/api/auth/login`, { data: { email, password } });
  expect(login.ok(), `signing in to ${API_URL} failed: ${login.status()}`).toBe(true);
  const { token } = (await login.json()) as { token: string };

  const res = await request.get(`${API_URL}/api/auth/onboarding`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.ok(), `reading the checklist failed: ${res.status()}`).toBe(true);
  return (await res.json()) as OnboardingState;
}

/** The path part of a URL, which is what a navigation assertion is actually about. */
export function pathOf(url: string, base = 'http://127.0.0.1'): string {
  return new URL(url, base).pathname;
}
