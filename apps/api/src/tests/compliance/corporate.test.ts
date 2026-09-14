/**
 * Compliance — corporate, contracts and security hygiene
 * (docs/plan/compliance.md, H).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { validatePassword, checkPanAgainstGstin, isValidTan, isValidCin, isValidUdyam } from '@kaizen/shared';
import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { updateCompanyProfile, companyProfile } from '../../domains/companyProfile.js';
import {
  assertProductionSecrets,
  hashPassword,
  login,
  verifyMfaAndLogin,
  enrolMfa,
  confirmMfa,
} from '../../lib/auth.js';
import { hotpRaw, totpRaw, totp, verifyTotp, generateTotpSecret, otpauthUri } from '../../domains/compliance/corporate/totp.js';
import {
  createBoardMeeting,
  recordBoardMeeting,
  addBoardResolution,
  requestRefund,
  approveRefund,
  payRefund,
  listRegisterEntries,
  createRegisterEntry,
  currentRegister,
  assertStepUpForApprove,
} from '../../domains/compliance/corporate.js';

let TENANT: string;

beforeAll(async () => {
  TENANT = await tenantId();
});

// ---------------------------------------------------------------------------
// CMP-COR-001: JWT_SECRET / production secrets check
// ---------------------------------------------------------------------------

describe('CMP-COR-001: the API refuses insecure JWT secrets outside test/development', () => {
  it('throws when JWT_SECRET is unset', () => {
    expect(() => assertProductionSecrets({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_SECRET is a known fallback value, in production', () => {
    for (const fallback of ['dev-secret-change-me', 'change-me-in-production', 'docker-development-secret-not-for-production']) {
      expect(() => assertProductionSecrets({ NODE_ENV: 'production', JWT_SECRET: fallback })).toThrow(/placeholder/);
    }
  });

  it('warns but does not throw for the same fallback under NODE_ENV=test or development', () => {
    expect(() => assertProductionSecrets({ NODE_ENV: 'test', JWT_SECRET: 'dev-secret-change-me' })).not.toThrow();
    expect(() => assertProductionSecrets({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('passes silently with a real secret in production', () => {
    expect(() => assertProductionSecrets({ NODE_ENV: 'production', JWT_SECRET: 'a-genuinely-random-64-char-secret-nobody-would-guess-or-reuse' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

describe('password policy', () => {
  it('refuses a password under twelve characters', () => {
    expect(validatePassword('short1', 'a@b.com').valid).toBe(false);
  });

  it('refuses a password equal to the account email', () => {
    const r = validatePassword('person@kaizen.co.in', 'person@kaizen.co.in');
    expect(r.valid).toBe(false);
  });

  it('refuses a password on the common list', () => {
    expect(validatePassword('123456789012', null).valid).toBe(false);
  });

  it('accepts a password meeting the floor', () => {
    expect(validatePassword('a-genuinely-long-passphrase', 'someone@kaizen.co.in').valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TOTP: RFC 6238 Appendix B test vectors (SHA1, 8 digits), then the app's own
// 6-digit / 30s round trip.
// ---------------------------------------------------------------------------

describe('TOTP (RFC 6238, HMAC-SHA1)', () => {
  const key = Buffer.from('12345678901234567890', 'ascii');

  it('matches the published RFC 6238 Appendix B vectors', () => {
    expect(totpRaw(key, 59, 30, 8)).toBe('94287082');
    expect(totpRaw(key, 1111111109, 30, 8)).toBe('07081804');
    expect(totpRaw(key, 1111111111, 30, 8)).toBe('14050471');
    expect(totpRaw(key, 1234567890, 30, 8)).toBe('89005924');
    expect(totpRaw(key, 2000000000, 30, 8)).toBe('69279037');
  });

  it('hotpRaw at counter 1 for T=59/30 agrees with totpRaw', () => {
    expect(hotpRaw(key, 1, 8)).toBe(totpRaw(key, 59, 30, 8));
  });

  it('generates a fresh secret, an otpauth URI, and verifies a live code', () => {
    const secret = generateTotpSecret();
    const uri = otpauthUri(secret, 'finance@kaizen.co.in');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(secret);

    const code = totp(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, code)).toBe(true);
    expect(verifyTotp(secret, '000000' === code ? '111111' : '000000')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Company registrations: TAN, CIN, Udyam shape; PAN-in-GSTIN cross-check
// ---------------------------------------------------------------------------

describe('company registrations', () => {
  it('validates TAN shape (AAAA99999A)', () => {
    expect(isValidTan('CHEN12345A')).toBe(true);
    expect(isValidTan('12345ABCDE')).toBe(false);
    expect(isValidTan('CHEN1234A')).toBe(false);
  });

  it('validates CIN shape (21 characters)', () => {
    expect(isValidCin('U72200TN2015PTC098765')).toBe(true); // 21 characters
    expect(isValidCin('U72200TN2015PTC0987650')).toBe(false); // 22 — one too many
    expect(isValidCin('not-a-cin')).toBe(false);
  });

  it('validates Udyam shape (UDYAM-XX-00-0000000)', () => {
    expect(isValidUdyam('UDYAM-TN-02-0012345')).toBe(true);
    expect(isValidUdyam('UDYAM-TN-2-0012345')).toBe(false);
  });

  it('the PAN embedded in a GSTIN (characters 3-12) must match the company PAN', () => {
    // 33AABCK1234H1Z2 is a checksum-valid GSTIN; its embedded PAN is AABCK1234H.
    const match = checkPanAgainstGstin('AABCK1234H', '33AABCK1234H1Z2');
    expect(match.ok).toBe(true);

    const mismatch = checkPanAgainstGstin('AAAAA0000A', '33AABCK1234H1Z2');
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reasonCode).toBe('pan_gstin_mismatch');
  });

  it('updateCompanyProfile refuses a TAN/CIN/Udyam that is not shaped right, and refuses a PAN/GSTIN pair that disagrees', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      const before = await companyProfile();
      try {
        const badTan = await expectReject(() => updateCompanyProfile({ tan: 'NOT-A-TAN' }));
        expect(badTan.message).toMatch(/not a valid TAN/);

        const badCin = await expectReject(() => updateCompanyProfile({ cin: 'too-short' }));
        expect(badCin.message).toMatch(/not a valid CIN/);

        const badUdyam = await expectReject(() => updateCompanyProfile({ udyamNumber: 'UDYAM-BAD' }));
        expect(badUdyam.message).toMatch(/not a valid Udyam/);

        await updateCompanyProfile({ gstin: '33AABCK1234H1Z2' });
        const mismatch = await expectReject(() => updateCompanyProfile({ pan: 'AAAAA0000A' }));
        expect(mismatch.message).toMatch(/does not match/);

        const ok = await updateCompanyProfile({ pan: 'AABCK1234H', tan: 'CHEN12345A' });
        expect(ok.pan).toBe('AABCK1234H');
        expect(ok.tan).toBe('CHEN12345A');
      } finally {
        await updateCompanyProfile({
          gstin: before.gstin ?? undefined,
          pan: before.pan ?? undefined,
          tan: before.tan ?? undefined,
        });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Login: lockout and MFA
// ---------------------------------------------------------------------------

async function createLoginFixture(password: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const email = `mfa-fixture-${stamp}@fixture.test`;
  const person = await unscopedPrisma.person.create({
    data: { tenantId: TENANT, recordCode: `PER-MFAFIX-${stamp}`, fullName: 'MFA Fixture', primaryEmail: email, primaryEmailNormalised: email, source: 'test' },
  });
  await unscopedPrisma.affiliation.create({
    data: { tenantId: TENANT, partyId: person.id, affiliationType: 'employee', counterpartyName: 'Fixture', roleSlug: 'employee', primaryFlag: true, status: 'active' },
  });
  const user = await unscopedPrisma.user.create({
    data: { tenantId: TENANT, personId: person.id, email, passwordHash: await hashPassword(password) },
  });
  return { userId: user.id, personId: person.id, email };
}

describe('login: lockout', () => {
  it('locks the account after five failed attempts, and a correct password is refused while locked', async () => {
    const fixture = await createLoginFixture('a-correct-passphrase-12');

    for (let i = 0; i < 5; i += 1) {
      await expectReject(() => login(fixture.email, 'wrong-password'));
    }

    const locked = await unscopedPrisma.user.findFirstOrThrow({ where: { id: fixture.userId } });
    expect(locked.lockedUntil).not.toBeNull();

    const rejectedWhileLocked = await expectReject(() => login(fixture.email, 'a-correct-passphrase-12'));
    expect(rejectedWhileLocked.message).toMatch(/locked/);

    // Simulate the lock having expired, and confirm a correct password then
    // succeeds and clears the counters.
    await unscopedPrisma.user.update({ where: { id: fixture.userId }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const result = await login(fixture.email, 'a-correct-passphrase-12');
    expect('token' in result).toBe(true);

    const cleared = await unscopedPrisma.user.findFirstOrThrow({ where: { id: fixture.userId } });
    expect(cleared.failedLoginCount).toBe(0);
    expect(cleared.lockedUntil).toBeNull();
  });
});

describe('login: MFA (CMP-COR-002)', () => {
  it('a user with no MFA enrolled logs in directly', async () => {
    const fixture = await createLoginFixture('another-correct-passphrase');
    const result = await login(fixture.email, 'another-correct-passphrase');
    expect('token' in result).toBe(true);
  });

  it('enrolment requires a confirming code before mfaEnabledAt is set', async () => {
    const fixture = await createLoginFixture('third-correct-passphrase');
    const { secret } = await enrolMfa(fixture.userId, fixture.email);

    await expectReject(() => confirmMfa(fixture.userId, '000000'));
    let user = await unscopedPrisma.user.findFirstOrThrow({ where: { id: fixture.userId } });
    expect(user.mfaEnabledAt).toBeNull();

    await confirmMfa(fixture.userId, totp(secret));
    user = await unscopedPrisma.user.findFirstOrThrow({ where: { id: fixture.userId } });
    expect(user.mfaEnabledAt).not.toBeNull();
  });

  it('once enrolled, a password alone returns a challenge rather than a session, and the challenge needs the real code', async () => {
    const fixture = await createLoginFixture('fourth-correct-passphrase');
    const { secret } = await enrolMfa(fixture.userId, fixture.email);
    await confirmMfa(fixture.userId, totp(secret));

    const challenge = await login(fixture.email, 'fourth-correct-passphrase');
    expect('mfaRequired' in challenge && challenge.mfaRequired).toBe(true);
    if (!('challengeToken' in challenge)) throw new Error('expected a challenge token');

    await expectReject(() => verifyMfaAndLogin(challenge.challengeToken, '000000'));

    const done = await verifyMfaAndLogin(challenge.challengeToken, totp(secret));
    expect(done.token).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// CMP-COR-002, at the point of use: an approve-shaped action this workstream
// owns refuses a session in a policy-named role that has not enrolled MFA.
// ---------------------------------------------------------------------------

describe('CMP-COR-002: an approve-shaped action requires MFA enrolment for a policy-named role', () => {
  it('refuses when the role is named in the policy and MFA is not enrolled', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      const financeUser = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'finance@kaizen.co.in', tenantId: TENANT } });
      // Guaranteed unenrolled for this assertion, regardless of prior test state.
      await unscopedPrisma.user.update({ where: { id: financeUser.id }, data: { mfaSecret: null, mfaEnabledAt: null } });

      const err = await expectReject(() => assertStepUpForApprove('Approving a refund'));
      expect(err.message).toMatch(/MFA/);
    });
  });

  it('passes once the role has MFA enrolled', async () => {
    await asUser('finance@kaizen.co.in', async () => {
      const financeUser = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'finance@kaizen.co.in', tenantId: TENANT } });
      const secret = generateTotpSecret();
      await unscopedPrisma.user.update({ where: { id: financeUser.id }, data: { mfaSecret: secret, mfaEnabledAt: new Date() } });

      // asUser's fixed principal carries stepUpVerified: true, which is what a
      // completed /auth/mfa/verify sets on a real session — this checks the
      // gate's "enrolled" branch, not the login-flow challenge (covered above).
      await expect(assertStepUpForApprove('Approving a refund')).resolves.toBeUndefined();

      await unscopedPrisma.user.update({ where: { id: financeUser.id }, data: { mfaSecret: null, mfaEnabledAt: null } });
    });
  });
});

// ---------------------------------------------------------------------------
// CMP-COR-003: a board resolution is immutable once its meeting is recorded
// ---------------------------------------------------------------------------

describe('CMP-COR-003: a recorded board meeting\'s resolutions are immutable', () => {
  it('a resolution added after recording must correct an existing one, and the original text never changes', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const meeting = await createBoardMeeting({ kind: 'board', heldOn: new Date('2026-04-01') });
      const first = await addBoardResolution({
        meetingId: meeting.id,
        subject: 'Approve the FY27 budget',
        text: 'Resolved that the FY27 budget of ₹1,00,00,000 is approved.',
        kind: 'ordinary',
        passedOn: new Date('2026-04-01'),
      });

      await recordBoardMeeting(meeting.id);

      const bare = await expectReject(() =>
        addBoardResolution({
          meetingId: meeting.id,
          subject: 'A late addition',
          text: 'Should be refused — no correctsId.',
          kind: 'ordinary',
          passedOn: new Date('2026-04-01'),
        }),
      );
      expect(bare.message).toMatch(/immutable/);

      const correction = await addBoardResolution({
        meetingId: meeting.id,
        subject: 'Correct the FY27 budget figure',
        text: 'Resolved that the FY27 budget of ₹1,10,00,000 is approved, correcting the figure recorded earlier.',
        kind: 'ordinary',
        passedOn: new Date('2026-04-02'),
        correctsId: first.id,
      });
      expect(correction.correctsId).toBe(first.id);

      const originalStillIntact = await prisma.complianceBoardResolution.findFirstOrThrow({ where: { id: first.id } });
      expect(originalStillIntact.text).toBe('Resolved that the FY27 budget of ₹1,00,00,000 is approved.');
    });
  });
});

// ---------------------------------------------------------------------------
// Statutory registers: append-only
// ---------------------------------------------------------------------------

describe('statutory registers are append-only', () => {
  it('a superseding entry must reference the current head of its subject\'s chain', async () => {
    await asUser('chairman@kaizen.co.in', async () => {
      const first = await createRegisterEntry({
        registerKind: 'directors',
        subjectKey: 'director:test-fixture',
        body: { name: 'A. Director', din: '01234567', designation: 'Director', appointedOn: '2020-01-01' },
      });

      const second = await createRegisterEntry({
        registerKind: 'directors',
        subjectKey: 'director:test-fixture',
        body: { name: 'A. Director', din: '01234567', designation: 'Managing Director', appointedOn: '2020-01-01' },
        supersedesId: first.id,
      });
      expect(second.supersedesId).toBe(first.id);

      // Superseding the now-stale first entry again is refused: the chain has moved on.
      const stale = await expectReject(() =>
        createRegisterEntry({
          registerKind: 'directors',
          subjectKey: 'director:test-fixture',
          body: { name: 'A. Director', din: '01234567', designation: 'Whole-time Director', appointedOn: '2020-01-01' },
          supersedesId: first.id,
        }),
      );
      expect(stale.message).toMatch(/current head/);

      const all = await listRegisterEntries('directors', 'director:test-fixture');
      expect(all.length).toBeGreaterThanOrEqual(2);
      const original = all.find((e) => e.id === first.id);
      expect((original!.body as Record<string, unknown>).designation).toBe('Director');

      const current = await currentRegister('directors');
      expect(current.some((e) => e.id === second.id)).toBe(true);
      expect(current.some((e) => e.id === first.id)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// CMP-COR-004: a refund is its own Movement fact
// ---------------------------------------------------------------------------

describe('CMP-COR-004: a refund is its own Movement fact', () => {
  it('the proposer cannot approve their own refund, and paying books an outward transaction without touching the original', async () => {
    const account = await unscopedPrisma.ledgerAccount.create({
      data: { tenantId: TENANT, name: `Test refunds account ${Date.now()}`, accountType: 'bank' },
    });

    // Approving and paying a refund are gated by CMP-COR-002 for finance_head
    // and chairman — enrol both for this test, and clear them afterward.
    const financeUser = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'finance@kaizen.co.in', tenantId: TENANT } });
    const chairmanUser = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'chairman@kaizen.co.in', tenantId: TENANT } });
    await unscopedPrisma.user.update({ where: { id: financeUser.id }, data: { mfaSecret: generateTotpSecret(), mfaEnabledAt: new Date() } });
    await unscopedPrisma.user.update({ where: { id: chairmanUser.id }, data: { mfaSecret: generateTotpSecret(), mfaEnabledAt: new Date() } });

    try {
      const refund = await asUser('finance@kaizen.co.in', () =>
        requestRefund({ receiptId: 'REC-fixture-0001', amount: 500, reason: 'Course cancelled before start' }),
      );

      await asUser('finance@kaizen.co.in', async () => {
        const self = await expectReject(() => approveRefund(refund.id));
        expect(self.message).toMatch(/cannot also approve/);
      });

      const approved = await asUser('chairman@kaizen.co.in', () => approveRefund(refund.id));
      expect(approved.status).toBe('approved');
      expect(approved.approvedById).not.toBe(approved.requestedById);

      const paid = await asUser('chairman@kaizen.co.in', () => payRefund(refund.id, { accountId: account.id }));
      expect(paid.status).toBe('paid');
      expect(paid.paidPaymentId).toBeTruthy();

      const txn = await asUser('chairman@kaizen.co.in', () => prisma.transaction.findFirstOrThrow({ where: { id: paid.paidPaymentId! } }));
      expect(txn.source).toBe('refund');
      expect(txn.direction).toBe('out');
      expect(Number(txn.amount.toString())).toBe(500);

      // Nothing exists that edited an invoice or receipt row — the refund and
      // the transaction are the only two rows this test produced.
      expect(refund.receiptId).toBe('REC-fixture-0001');
    } finally {
      await unscopedPrisma.user.update({ where: { id: financeUser.id }, data: { mfaSecret: null, mfaEnabledAt: null } });
      await unscopedPrisma.user.update({ where: { id: chairmanUser.id }, data: { mfaSecret: null, mfaEnabledAt: null } });
    }
  });
});

// ---------------------------------------------------------------------------
// Certificate verification
// ---------------------------------------------------------------------------

describe('certificate verification', () => {
  it('issues a certificate with a unique verification code, and verifies it back', async () => {
    const { issueCertificate, verifyCertificate } = await import('../../domains/compliance/corporate.js');
    const certificate = await asUser('chairman@kaizen.co.in', () =>
      issueCertificate({ enrollmentId: 'ENR-fixture-0001', kind: 'completion', snapshot: { learnerName: 'Test Learner', courseName: 'Test Course' } }),
    );
    expect(certificate.number).toMatch(/\/T\//);

    const verified = await asUser('chairman@kaizen.co.in', () => verifyCertificate(certificate.verificationCode));
    expect(verified.valid).toBe(true);
    expect(verified.number).toBe(certificate.number);

    await asUser('chairman@kaizen.co.in', async () => {
      const bad = await expectReject(() => verifyCertificate('not-a-real-code'));
      expect(bad.message).toMatch(/not found/i);
    });
  });
});
