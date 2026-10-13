-- Payroll money columns to bigint paise (ORDERED-PLAN 1.6; MONEY-S9).
--
-- Thirty-nine Decimal money columns in the payroll workstream become paise in place,
-- each renamed to the `<name>Minor` convention the other paise columns follow, with
-- the same type change and the same guard as the HCM slice (20261013226000):
--
--   cmp_pay_salary_structures          ctcAnnual, basic, hra, specialAllowance, conveyance,
--                                      employerPfMonthly, employerEsiMonthly
--   cmp_pay_gratuity_accruals          accrued
--   compliance_labour_leave_encashments amount
--   compliance_labour_overtime_accruals rate, amount
--   payroll_statutory_lines            amount
--   hcm_adhoc_pay_lines, hcm_arrears   amount
--   hcm_payroll_journals               totalDebit, totalCredit
--   hcm_bank_advices                   total
--   payroll_instructions               grossAmount, deductions, netAmount, basicPay, hra,
--                                      otherAllowances, pfEmployee, pfEmployer, epsEmployer,
--                                      esiEmployee, esiEmployer, professionalTax, tdsAmount,
--                                      lwfEmployee, lwfEmployer
--   payroll_runs                       grossTotal, netTotal
--   offboardings                       settlementAmount, gratuityAmount, leaveEncashmentAmount,
--                                      bonusAmount, noticeRecoveryAmount
--
-- compensation_records (basicPay, amount) and learning_activities (cost) are read by
-- the HCM compensation and import paths as well as payroll, so they are a later slice
-- and are not touched here.
--
-- Nothing in the migration history (views, triggers, functions, CHECK constraints)
-- names these columns, so no dependent object blocks the type change. The one trigger
-- on payroll (hcm_payroll_division_lines) guards a table this migration does not touch.
--
-- The GUARD is the part that matters: a stored value with a third decimal can only be
-- there if the column drifted to an unconstrained type or a restore brought one in.
-- Rounding it here would hide exactly that, so the migration stops instead.

-- GUARD BEGIN
-- This migration runs as the table owner, and FORCE RLS binds the owner
-- (20261010235900_tenant_rls). Read with no tenant set, the payroll tables show no
-- rows, so the guard walks the tenants and sets the tenant on each pass.
DO $$
DECLARE
  tenant RECORD;
BEGIN
  FOR tenant IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant."id", true);
    IF FALSE
       OR EXISTS (SELECT 1 FROM "cmp_pay_salary_structures" WHERE "ctcAnnual" <> round("ctcAnnual", 2) OR "basic" <> round("basic", 2) OR "hra" <> round("hra", 2) OR "specialAllowance" <> round("specialAllowance", 2) OR "conveyance" <> round("conveyance", 2) OR "employerPfMonthly" <> round("employerPfMonthly", 2) OR "employerEsiMonthly" <> round("employerEsiMonthly", 2))
       OR EXISTS (SELECT 1 FROM "cmp_pay_gratuity_accruals" WHERE "accrued" <> round("accrued", 2))
       OR EXISTS (SELECT 1 FROM "compliance_labour_leave_encashments" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "compliance_labour_overtime_accruals" WHERE "rate" <> round("rate", 2) OR "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "payroll_statutory_lines" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "hcm_adhoc_pay_lines" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "hcm_arrears" WHERE "amount" <> round("amount", 2))
       OR EXISTS (SELECT 1 FROM "hcm_payroll_journals" WHERE "totalDebit" <> round("totalDebit", 2) OR "totalCredit" <> round("totalCredit", 2))
       OR EXISTS (SELECT 1 FROM "hcm_bank_advices" WHERE "total" <> round("total", 2))
       OR EXISTS (SELECT 1 FROM "payroll_instructions" WHERE "grossAmount" <> round("grossAmount", 2) OR "deductions" <> round("deductions", 2) OR "netAmount" <> round("netAmount", 2) OR "basicPay" <> round("basicPay", 2) OR "hra" <> round("hra", 2) OR "otherAllowances" <> round("otherAllowances", 2) OR "pfEmployee" <> round("pfEmployee", 2) OR "pfEmployer" <> round("pfEmployer", 2) OR "epsEmployer" <> round("epsEmployer", 2) OR "esiEmployee" <> round("esiEmployee", 2) OR "esiEmployer" <> round("esiEmployer", 2) OR "professionalTax" <> round("professionalTax", 2) OR "tdsAmount" <> round("tdsAmount", 2) OR "lwfEmployee" <> round("lwfEmployee", 2) OR "lwfEmployer" <> round("lwfEmployer", 2))
       OR EXISTS (SELECT 1 FROM "payroll_runs" WHERE "grossTotal" <> round("grossTotal", 2) OR "netTotal" <> round("netTotal", 2))
       OR EXISTS (SELECT 1 FROM "offboardings" WHERE "settlementAmount" <> round("settlementAmount", 2) OR "gratuityAmount" <> round("gratuityAmount", 2) OR "leaveEncashmentAmount" <> round("leaveEncashmentAmount", 2) OR "bonusAmount" <> round("bonusAmount", 2) OR "noticeRecoveryAmount" <> round("noticeRecoveryAmount", 2))
    THEN
      RAISE EXCEPTION 'A payroll money column holds a value with more than two decimal places; this migration will not round it into paise. Correct the value and re-run.'
        USING ERRCODE = 'data_exception';
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END
$$;
-- GUARD END

-- cmp_pay_salary_structures
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "ctcAnnual" TYPE BIGINT USING (round("ctcAnnual" * 100))::BIGINT;
ALTER TABLE "cmp_pay_salary_structures" RENAME COLUMN "ctcAnnual" TO "ctcAnnualMinor";
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "basic" TYPE BIGINT USING (round("basic" * 100))::BIGINT;
ALTER TABLE "cmp_pay_salary_structures" RENAME COLUMN "basic" TO "basicMinor";
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "hra" TYPE BIGINT USING (round("hra" * 100))::BIGINT;
ALTER TABLE "cmp_pay_salary_structures" RENAME COLUMN "hra" TO "hraMinor";
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "specialAllowance" DROP DEFAULT;
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "specialAllowance" TYPE BIGINT USING (round("specialAllowance" * 100))::BIGINT;
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "specialAllowance" SET DEFAULT 0;
ALTER TABLE "cmp_pay_salary_structures" RENAME COLUMN "specialAllowance" TO "specialAllowanceMinor";
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "conveyance" DROP DEFAULT;
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "conveyance" TYPE BIGINT USING (round("conveyance" * 100))::BIGINT;
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "conveyance" SET DEFAULT 0;
ALTER TABLE "cmp_pay_salary_structures" RENAME COLUMN "conveyance" TO "conveyanceMinor";
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "employerPfMonthly" DROP DEFAULT;
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "employerPfMonthly" TYPE BIGINT USING (round("employerPfMonthly" * 100))::BIGINT;
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "employerPfMonthly" SET DEFAULT 0;
ALTER TABLE "cmp_pay_salary_structures" RENAME COLUMN "employerPfMonthly" TO "employerPfMonthlyMinor";
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "employerEsiMonthly" DROP DEFAULT;
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "employerEsiMonthly" TYPE BIGINT USING (round("employerEsiMonthly" * 100))::BIGINT;
ALTER TABLE "cmp_pay_salary_structures" ALTER COLUMN "employerEsiMonthly" SET DEFAULT 0;
ALTER TABLE "cmp_pay_salary_structures" RENAME COLUMN "employerEsiMonthly" TO "employerEsiMonthlyMinor";

-- cmp_pay_gratuity_accruals
ALTER TABLE "cmp_pay_gratuity_accruals" ALTER COLUMN "accrued" TYPE BIGINT USING (round("accrued" * 100))::BIGINT;
ALTER TABLE "cmp_pay_gratuity_accruals" RENAME COLUMN "accrued" TO "accruedMinor";

-- compliance_labour_leave_encashments
ALTER TABLE "compliance_labour_leave_encashments" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "compliance_labour_leave_encashments" RENAME COLUMN "amount" TO "amountMinor";

-- compliance_labour_overtime_accruals
ALTER TABLE "compliance_labour_overtime_accruals" ALTER COLUMN "rate" TYPE BIGINT USING (round("rate" * 100))::BIGINT;
ALTER TABLE "compliance_labour_overtime_accruals" RENAME COLUMN "rate" TO "rateMinor";
ALTER TABLE "compliance_labour_overtime_accruals" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "compliance_labour_overtime_accruals" RENAME COLUMN "amount" TO "amountMinor";

-- payroll_statutory_lines
ALTER TABLE "payroll_statutory_lines" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "payroll_statutory_lines" RENAME COLUMN "amount" TO "amountMinor";

-- hcm_adhoc_pay_lines
ALTER TABLE "hcm_adhoc_pay_lines" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "hcm_adhoc_pay_lines" RENAME COLUMN "amount" TO "amountMinor";

-- hcm_arrears
ALTER TABLE "hcm_arrears" ALTER COLUMN "amount" TYPE BIGINT USING (round("amount" * 100))::BIGINT;
ALTER TABLE "hcm_arrears" RENAME COLUMN "amount" TO "amountMinor";

-- hcm_payroll_journals
ALTER TABLE "hcm_payroll_journals" ALTER COLUMN "totalDebit" TYPE BIGINT USING (round("totalDebit" * 100))::BIGINT;
ALTER TABLE "hcm_payroll_journals" RENAME COLUMN "totalDebit" TO "totalDebitMinor";
ALTER TABLE "hcm_payroll_journals" ALTER COLUMN "totalCredit" TYPE BIGINT USING (round("totalCredit" * 100))::BIGINT;
ALTER TABLE "hcm_payroll_journals" RENAME COLUMN "totalCredit" TO "totalCreditMinor";

-- hcm_bank_advices
ALTER TABLE "hcm_bank_advices" ALTER COLUMN "total" TYPE BIGINT USING (round("total" * 100))::BIGINT;
ALTER TABLE "hcm_bank_advices" RENAME COLUMN "total" TO "totalMinor";

-- payroll_instructions
ALTER TABLE "payroll_instructions" ALTER COLUMN "grossAmount" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "grossAmount" TYPE BIGINT USING (round("grossAmount" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "grossAmount" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "grossAmount" TO "grossAmountMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "deductions" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "deductions" TYPE BIGINT USING (round("deductions" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "deductions" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "deductions" TO "deductionsMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "netAmount" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "netAmount" TYPE BIGINT USING (round("netAmount" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "netAmount" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "netAmount" TO "netAmountMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "basicPay" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "basicPay" TYPE BIGINT USING (round("basicPay" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "basicPay" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "basicPay" TO "basicPayMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "hra" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "hra" TYPE BIGINT USING (round("hra" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "hra" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "hra" TO "hraMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "otherAllowances" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "otherAllowances" TYPE BIGINT USING (round("otherAllowances" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "otherAllowances" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "otherAllowances" TO "otherAllowancesMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "pfEmployee" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "pfEmployee" TYPE BIGINT USING (round("pfEmployee" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "pfEmployee" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "pfEmployee" TO "pfEmployeeMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "pfEmployer" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "pfEmployer" TYPE BIGINT USING (round("pfEmployer" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "pfEmployer" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "pfEmployer" TO "pfEmployerMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "epsEmployer" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "epsEmployer" TYPE BIGINT USING (round("epsEmployer" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "epsEmployer" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "epsEmployer" TO "epsEmployerMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "esiEmployee" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "esiEmployee" TYPE BIGINT USING (round("esiEmployee" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "esiEmployee" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "esiEmployee" TO "esiEmployeeMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "esiEmployer" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "esiEmployer" TYPE BIGINT USING (round("esiEmployer" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "esiEmployer" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "esiEmployer" TO "esiEmployerMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "professionalTax" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "professionalTax" TYPE BIGINT USING (round("professionalTax" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "professionalTax" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "professionalTax" TO "professionalTaxMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "tdsAmount" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "tdsAmount" TYPE BIGINT USING (round("tdsAmount" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "tdsAmount" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "tdsAmount" TO "tdsAmountMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "lwfEmployee" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "lwfEmployee" TYPE BIGINT USING (round("lwfEmployee" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "lwfEmployee" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "lwfEmployee" TO "lwfEmployeeMinor";
ALTER TABLE "payroll_instructions" ALTER COLUMN "lwfEmployer" DROP DEFAULT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "lwfEmployer" TYPE BIGINT USING (round("lwfEmployer" * 100))::BIGINT;
ALTER TABLE "payroll_instructions" ALTER COLUMN "lwfEmployer" SET DEFAULT 0;
ALTER TABLE "payroll_instructions" RENAME COLUMN "lwfEmployer" TO "lwfEmployerMinor";

-- payroll_runs
ALTER TABLE "payroll_runs" ALTER COLUMN "grossTotal" DROP DEFAULT;
ALTER TABLE "payroll_runs" ALTER COLUMN "grossTotal" TYPE BIGINT USING (round("grossTotal" * 100))::BIGINT;
ALTER TABLE "payroll_runs" ALTER COLUMN "grossTotal" SET DEFAULT 0;
ALTER TABLE "payroll_runs" RENAME COLUMN "grossTotal" TO "grossTotalMinor";
ALTER TABLE "payroll_runs" ALTER COLUMN "netTotal" DROP DEFAULT;
ALTER TABLE "payroll_runs" ALTER COLUMN "netTotal" TYPE BIGINT USING (round("netTotal" * 100))::BIGINT;
ALTER TABLE "payroll_runs" ALTER COLUMN "netTotal" SET DEFAULT 0;
ALTER TABLE "payroll_runs" RENAME COLUMN "netTotal" TO "netTotalMinor";

-- offboardings
ALTER TABLE "offboardings" ALTER COLUMN "settlementAmount" TYPE BIGINT USING (round("settlementAmount" * 100))::BIGINT;
ALTER TABLE "offboardings" RENAME COLUMN "settlementAmount" TO "settlementAmountMinor";
ALTER TABLE "offboardings" ALTER COLUMN "gratuityAmount" TYPE BIGINT USING (round("gratuityAmount" * 100))::BIGINT;
ALTER TABLE "offboardings" RENAME COLUMN "gratuityAmount" TO "gratuityAmountMinor";
ALTER TABLE "offboardings" ALTER COLUMN "leaveEncashmentAmount" TYPE BIGINT USING (round("leaveEncashmentAmount" * 100))::BIGINT;
ALTER TABLE "offboardings" RENAME COLUMN "leaveEncashmentAmount" TO "leaveEncashmentAmountMinor";
ALTER TABLE "offboardings" ALTER COLUMN "bonusAmount" TYPE BIGINT USING (round("bonusAmount" * 100))::BIGINT;
ALTER TABLE "offboardings" RENAME COLUMN "bonusAmount" TO "bonusAmountMinor";
ALTER TABLE "offboardings" ALTER COLUMN "noticeRecoveryAmount" TYPE BIGINT USING (round("noticeRecoveryAmount" * 100))::BIGINT;
ALTER TABLE "offboardings" RENAME COLUMN "noticeRecoveryAmount" TO "noticeRecoveryAmountMinor";
