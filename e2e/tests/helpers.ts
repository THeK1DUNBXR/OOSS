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
  await useSessionToken(page, await sessionToken(page.request, email, password));

  await page.goto('/');

  // The landing screen depends on the role, so wait for the shell rather than
  // for a path: every signed-in person has the sidebar and nobody else does.
  await expect(page.getByRole('link', { name: 'Getting Started' })).toBeVisible();
}

const sessionTokens = new Map<string, string>();

/**
 * One API sign-in per account per run, shared by every test that needs it.
 *
 * Signing in through the form in every test used up the API's sign-in budget
 * (five a minute per address, `rateLimit.ts`) partway through the suite, and the
 * next test to sign in failed on a 429 that looked like a broken sidebar. The
 * session is the token the app itself keeps, so handing it over is the same
 * session a form sign-in would have produced.
 */
export async function sessionToken(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const cached = sessionTokens.get(email);
  if (cached) return cached;
  const login = await request.post(`${API_URL}/api/auth/login`, { data: { email, password } });
  expect(login.ok(), `signing in to ${API_URL} failed: ${login.status()}`).toBe(true);
  const { token } = (await login.json()) as { token: string };
  sessionTokens.set(email, token);
  return token;
}

/**
 * Puts a session token where the app reads it on load, before any page script
 * runs. The one-off orientation modal is dismissed here too, as a real user
 * would dismiss it once.
 */
export async function useSessionToken(page: Page, token: string): Promise<void> {
  await page.addInitScript((t: string) => {
    try {
      window.localStorage.setItem('kaizen.seenIntro', '1');
      window.localStorage.setItem('kaizen.token', t);
    } catch {
      /* a browser without storage shows the modal and signs out; nothing to do */
    }
  }, token);
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
  const token = await sessionToken(request, email, password);

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
