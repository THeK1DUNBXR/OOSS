/**
 * Concurrent allocations against one payment (CI-GATES-DRAFT section 2, L3).
 *
 * N allocation requests for one payment are released together behind a gate and
 * run through the real domain function, allocatePayment, each in its own
 * transaction on the shared pool. The payment is generated so that the requests
 * together exceed it, which makes the payment's balance the thing that binds.
 *
 * What the test defends. allocatePayment checks the unallocated amount of the
 * payment inside the payment's row lock (domains/allocation.ts lockPayment). Take
 * that lock away and the check reads a stale total: two transactions both see the
 * same unallocated amount, both pass, and the payment is allocated past its
 * value. The run below fails then, and it is the evidence that the lock is what
 * holds the line.
 *
 * Sizes. The per-PR run is L3_CONCURRENCY=50; the phase-end run is 200
 * (CI-GATES-DRAFT section 5, question 8; proof-full.yml). The number of
 * repetitions with different seeds is L3_RUNS (the draft asks for 20 at phase
 * end). A seed is printed with each run so any failure can be replayed with
 * L3_SEED.
 *
 * Latency. Each request's time is measured from the release to its response, and
 * the p50 and p95 are printed on every run. The p95 is asserted only when
 * L3_P95_CEILING_MS is set. The phase-end run sets it to 2000: the owner decision
 * on CI-GATES-DRAFT section 5, question 8, recorded 2026-10-12. The per-PR run
 * leaves it unset and reports only, because the owner set the ceiling for the
 * full run and not for the short one.
 *
 * Not asserted: that each accepted allocation posts a journal entry. The draft
 * says it does, but allocatePayment writes no journal rows (domains/finance.ts
 * allocatePayment, no post or postInTx call). The trial balance is checked
 * because the brief asks for it, and it is a check on the tenant's journal as a
 * whole, not on these allocations.
 */

import { describe, expect, it } from 'vitest';
import { formatMinor, parseMinor } from '@kaizen/shared';
import { asUser, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { createInvoice } from '../../domains/invoicing.js';
import { allocatePayment, recordPayment } from '../../domains/finance.js';
import { documentNumbering } from '../../domains/companyProfile.js';
import { ApiError } from '../../platform/errors.js';
import { assertTrialBalance, journalTrialBalance } from '../../platform/balances.js';
import { DOCUMENT_SERIES, nextDocumentNumber } from '../../platform/documentNumber.js';

const EMAIL = 'latha@kaizen.co.in';

const N = Number(process.env.L3_CONCURRENCY ?? 50);
const RUNS = Number(process.env.L3_RUNS ?? 1);
const BASE_SEED = Number(process.env.L3_SEED ?? 20261012);
// Owner decision, CI-GATES-DRAFT section 5 question 8, 2026-10-12: the full run fails above a 2 s p95.
const P95_CEILING_MS = process.env.L3_P95_CEILING_MS === undefined ? undefined : Number(process.env.L3_P95_CEILING_MS);

if (!Number.isInteger(N) || N < 1) throw new Error(`L3_CONCURRENCY must be a positive integer, got ${N}`);
if (!Number.isInteger(RUNS) || RUNS < 1) throw new Error(`L3_RUNS must be a positive integer, got ${RUNS}`);
if (P95_CEILING_MS !== undefined && !(P95_CEILING_MS > 0)) {
  throw new Error(`L3_P95_CEILING_MS must be a positive number of milliseconds, got ${process.env.L3_P95_CEILING_MS}`);
}

/** A small seeded generator, so a run is reproduced exactly from its seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function anAccount() {
  const tid = await tenantId();
  const account = await unscopedPrisma.account.findFirstOrThrow({
    where: { tenantId: tid, gstin: { not: null } },
  });
  return account.organizationId;
}

type Outcome =
  | { ok: true; paise: bigint; ms: number; receiptId: string; recordCode: string }
  | { ok: false; paise: bigint; ms: number; error: unknown };

async function oneRun(seed: number) {
  const rand = mulberry32(seed);
  // Between Rs 10.00 and Rs 1,000.00 each, in paise.
  const amounts = Array.from({ length: N }, () => BigInt(1_000 + Math.floor(rand() * 99_000)));
  const requested = amounts.reduce((s, a) => s + a, 0n);
  // 25% to 60% of what is asked for, so the payment is exhausted part-way through.
  const paymentPaise = (requested * BigInt(25 + Math.floor(rand() * 36))) / 100n;

  return asUser(EMAIL, async () => {
    // One invoice, far larger than the requests: the invoice's balance must not be what binds.
    const invoice = await createInvoice({
      organizationId: await anAccount(),
      placeOfSupply: '33',
      lines: [{ description: `L3 seed ${seed}`, unitPrice: 10_000_000, gstRate: 18 }],
    });
    const payment = await recordPayment({
      amount: Number(formatMinor(paymentPaise)),
      gatewayReference: `L3-${seed}-${Date.now()}`,
    });

    const { prefix, yearFormat } = await documentNumbering();
    // A number taken before and after the run, both committed. The sequence advances
    // by one per receipt issued, so the difference minus one is what the run consumed.
    const before = await prisma.$transaction((tx) =>
      nextDocumentNumber(tx, DOCUMENT_SERIES.receipt, prefix, new Date(), yearFormat),
    );

    // Released together. Each attempt waits on the gate after its own setup, so the
    // requests contend inside allocatePayment, not on the invoice fixture.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const attempts = amounts.map(async (paise): Promise<Outcome> => {
      await gate;
      const started = performance.now();
      try {
        const receipt = await allocatePayment({
          paymentId: payment.id,
          invoiceId: invoice.id,
          amount: Number(formatMinor(paise)),
        });
        return {
          ok: true,
          paise,
          ms: performance.now() - started,
          receiptId: receipt.id,
          recordCode: receipt.recordCode,
        };
      } catch (error) {
        return { ok: false, paise, ms: performance.now() - started, error };
      }
    });
    const wallStart = performance.now();
    open();
    const outcomes = await Promise.all(attempts);
    const wallMs = performance.now() - wallStart;

    const after = await prisma.$transaction((tx) =>
      nextDocumentNumber(tx, DOCUMENT_SERIES.receipt, prefix, new Date(), yearFormat),
    );

    const accepted = outcomes.filter((o): o is Extract<Outcome, { ok: true }> => o.ok);
    const rejected = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
    const acceptedSum = accepted.reduce((s, o) => s + o.paise, 0n);

    const receipts = await prisma.receipt.findMany({ where: { paymentId: payment.id } });
    const persistedSum = receipts.reduce((s, r) => s + parseMinor(r.allocatedAmount.toFixed(2)), 0n);
    const seqOf = (code: string) => Number(code.split('/').pop());
    const seqs = accepted.map((o) => seqOf(o.recordCode)).sort((a, b) => a - b);

    // Refusals are the insufficient-balance error. Anything else, including a
    // database deadlock or a pool timeout, is an unexpected failure, not a refusal.
    const serverErrors = rejected.filter((o) => !(o.error instanceof ApiError) || o.error.status >= 500);
    const refusedWithOtherCode = rejected.filter((o) => o.error instanceof ApiError && o.error.status !== 422);

    const tb = await journalTrialBalance(new Date());

    return {
      seed,
      paymentPaise,
      requested,
      acceptedSum,
      persistedSum,
      accepted: accepted.length,
      rejected: rejected.length,
      serverErrors,
      refusedWithOtherCode,
      seqs,
      consumed: Number(after.split('/').pop()) - Number(before.split('/').pop()) - 1,
      latencies: outcomes.map((o) => o.ms).sort((a, b) => a - b),
      wallMs,
      trialBalance: tb,
    };
  });
}

describe(`L3: ${N} concurrent allocations against one payment`, () => {
  for (let run = 0; run < RUNS; run++) {
    const seed = BASE_SEED + run;
    it(`seed ${seed}: never over-allocates, never 5xx, gapless receipts, trial balance zero`, async () => {
      const r = await oneRun(seed);

      const p50 = percentile(r.latencies, 50);
      const p95 = percentile(r.latencies, 95);
      console.log(
        `L3 seed=${seed} N=${N} accepted=${r.accepted} rejected=${r.rejected} ` +
          `paymentPaise=${r.paymentPaise} acceptedPaise=${r.acceptedSum} ` +
          `p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms wall=${r.wallMs.toFixed(1)}ms`,
      );

      // The total allocated never exceeds the payment, and what the receipts hold is exactly what was accepted.
      expect(r.acceptedSum <= r.paymentPaise, `over-allocated by ${r.acceptedSum - r.paymentPaise} paise`).toBe(true);
      expect(r.persistedSum).toBe(r.acceptedSum);
      expect(r.accepted + r.rejected).toBe(N);

      // No 5xx and no unexpected error. Every refusal is the insufficient-balance one.
      expect(r.serverErrors.map((o) => (o.error as Error).message)).toEqual([]);
      expect(r.refusedWithOtherCode.map((o) => (o.error as ApiError).status)).toEqual([]);

      // Accepted receipts take consecutive numbers, and a refused attempt takes none.
      const contiguous = r.seqs.every((s, i) => s === r.seqs[0]! + i);
      expect(contiguous, `receipt sequence has a gap: ${r.seqs.join(',')}`).toBe(true);
      expect(r.consumed).toBe(r.accepted);

      // The journal balances afterwards.
      expect(() => assertTrialBalance(r.trialBalance)).not.toThrow();
      expect(r.trialBalance.debitsMinor).toBe(r.trialBalance.creditsMinor);

      // Owner decision, CI-GATES-DRAFT section 5 question 8, 2026-10-12. Only when set.
      if (P95_CEILING_MS !== undefined) {
        expect(p95, `p95 ${p95.toFixed(1)}ms exceeds the ${P95_CEILING_MS}ms ceiling`).toBeLessThanOrEqual(
          P95_CEILING_MS,
        );
      }
    });
  }
});
