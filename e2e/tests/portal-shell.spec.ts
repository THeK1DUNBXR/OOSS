/**
 * The portal shell, for a portal-archetype principal (shareholder or
 * director): no ERP sidebar renders, ever, and the masthead is what stands
 * in for it.
 *
 * There is no seeded portal account in the stack these tests otherwise run
 * against — phase 0 lands no register, so a shareholder relationship has to
 * be created by hand (`POST /auth/sign-ins`, plan §6 item 4) before this can
 * sign in as anyone. Skipped unless a portal account is named, the same
 * pattern `helpers.ts`'s `credentials()` uses for the ERP account.
 */

import { expect, test } from '@playwright/test';

function portalCredentials(): { email: string; password: string } | null {
  const email = process.env.E2E_PORTAL_EMAIL;
  const password = process.env.E2E_PORTAL_PASSWORD;
  if (!email || !password) return null;
  return { email, password };
}

test.describe('the portal shell', () => {
  test.beforeEach(() => {
    test.skip(
      !portalCredentials(),
      'set E2E_PORTAL_EMAIL and E2E_PORTAL_PASSWORD to a shareholder or director account to run this',
    );
  });

  test('a portal principal gets the masthead and never the ERP sidebar', async ({ page }) => {
    const { email, password } = portalCredentials()!;

    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('kaizen.seenIntro', '1');
      } catch {
        /* a browser without storage still shows the modal; nothing to do */
      }
    });

    await page.goto('/');
    await page.locator('input[type=email]').fill(email);
    await page.locator('input[type=password]').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The masthead names the entity and the person — the portal's stand-in
    // for the sidebar's own brand mark and "signed in as" line.
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    // No ERP surface reaches this shell at all: neither its sidebar's own
    // command-palette trigger nor a Getting Started link (the ERP-only
    // checklist `signIn()` in `helpers.ts` waits for) ever renders here.
    await expect(page.getByRole('link', { name: 'Getting Started' })).toHaveCount(0);
    await expect(page.locator('aside.sidebar')).toHaveCount(0);
  });
});
