-- A receipt allocates a positive amount, and the receipts on one payment never add up to
-- more than the payment (ORDERED-PLAN "Payment allocation"). Until now both rules lived only
-- in allocatePayment (finance.ts:275) and collectInvoicePayment (invoicing.ts:1368), so a
-- write that skipped them, or a second path added later, could over-allocate a payment.
--
-- The positive-amount rule sees one row, so it is a CHECK. The payment-sum rule spans rows:
-- a CHECK cannot read the other receipts, so it is a deferred constraint trigger. It runs at
-- commit, so several receipts written in one transaction are summed together.
--
-- The trigger locks the payment row before it sums. Without the lock, two transactions that
-- each allocate 60 against a payment of 100 both read zero receipts and both commit at 120.
-- Under READ COMMITTED the sum runs after the lock is granted, so it sees the other commit.
--
-- A payment amount is not CHECKed to be positive: reversePayment (finance.ts:231) writes a
-- negative payment. A negative payment has no receipts, so the sum rule refuses any allocation
-- against it.

ALTER TABLE "receipts"
  ADD CONSTRAINT "receipts_allocatedAmount_positive" CHECK ("allocatedAmount" > 0);

CREATE OR REPLACE FUNCTION "payment_allocation_within_amount"(pid TEXT)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  payment_amount NUMERIC(18,2);
  allocated NUMERIC(18,2);
BEGIN
  SELECT "amount" INTO payment_amount FROM "payments" WHERE "id" = pid FOR UPDATE;
  -- RLS hides another tenant's payment from this query, so a missing row here is a receipt
  -- naming a payment this tenant cannot see. Refused, not passed: NULL > NULL is not a refusal.
  IF NOT FOUND THEN RAISE EXCEPTION 'receipt names a payment this tenant cannot see'; END IF;

  SELECT COALESCE(SUM("allocatedAmount"), 0) INTO allocated FROM "receipts" WHERE "paymentId" = pid;
  IF allocated > payment_amount THEN
    RAISE EXCEPTION 'receipts allocate more than the payment amount: % against %', allocated, payment_amount;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION "receipt_allocation_within_payment"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "payment_allocation_within_amount"(NEW."paymentId");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "receipt_allocation_within_payment"
AFTER INSERT OR UPDATE ON "receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "receipt_allocation_within_payment"();

CREATE OR REPLACE FUNCTION "payment_amount_covers_receipts"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "payment_allocation_within_amount"(NEW."id");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "payment_amount_covers_receipts"
AFTER UPDATE OF "amount" ON "payments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "payment_amount_covers_receipts"();
