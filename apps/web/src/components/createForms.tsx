/**
 * The forms that were missing.
 *
 * Each of these fronts an endpoint that already existed, was already tested and
 * was already unreachable — you could not raise an invoice, record a payment,
 * add a customer or put an employee on the books from the interface. They are
 * gathered in one file rather than scattered across their pages because they
 * are the same shape, and keeping them together is what stops the next one
 * being written from scratch and therefore never being written.
 *
 * Every one of them opens from a `+` button on the surface that lists the thing
 * it creates, so the answer to "how do I add one of these" is always in the
 * same place.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import {
  BLOOD_GROUPS,
  DELIVERY_LOCATIONS,
  DELIVERY_LOCATION_LABELS,
  EMPLOYMENT_ENGAGEMENT_TYPES,
  COMPENSATION_REVISION_REASONS,
  PROMOTION_REVISION_REASON,
  ASSIGNMENT_REASON_CODES,
  FUNDING_FRAMEWORKS,
  FUNDING_FRAMEWORK_LABELS,
  FUNDING_SOURCES,
  FUNDING_SOURCE_LABELS,
  INSTITUTION_ENGAGEMENTS,
  INSTITUTION_ENGAGEMENT_HINTS,
  INSTITUTION_ENGAGEMENT_LABELS,
  ORGANIZATION_ROLES,
  ORGANIZATION_ROLE_HINTS,
  ORGANIZATION_ROLE_LABELS,
  type AssignmentReasonCode,
  type BloodGroup,
  type CompensationRevisionReason,
  type EmploymentEngagementType,
  type FundingSource,
  type InstitutionEngagement,
  type OrganizationRole,
  ageInYears,
} from '@kaizen/shared';
import { api, titleCase } from '../lib/api.js';
import { CreateModal, MoneyInput, Row, SelectInput, TextArea, TextInput } from './forms.js';
import { Field, MoneyField, moneyField, rupeesOnWire, useZodForm } from './zodForm.js';
import { AgeBasisFields, ageBasisBody, type AgeBasisValues } from './learnerAge.js';

/**
 * A list endpoint's rows, whichever shape it returns them in.
 *
 * The CRM endpoints answer with `{ items, total, page, pageSize }` and the
 * books endpoints answer with a bare array. Both are defensible and the
 * inconsistency is real; what is not acceptable is that calling `.map` on the
 * wrong one takes the whole screen down with a white page, which is exactly
 * what the invoice form did the first time it was opened.
 *
 * Unwrapping in one place means a form cannot get this wrong, and a list that
 * has not loaded yet reads as empty rather than as a crash.
 */
function rowsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const items = (data as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}

function useList<T>(key: string, path: string, enabled = true) {
  const query = useQuery({ queryKey: [key], queryFn: () => api.get<unknown>(path), enabled });
  return { ...query, rows: rowsOf<T>(query.data) };
}

const today = () => new Date().toISOString().slice(0, 10);

const DIVISIONS = [
  { value: 'software', label: 'Software' },
  { value: 'skill', label: 'Skill Development' },
  { value: 'education', label: 'Education' },
  { value: 'shared', label: 'Shared' },
];

interface Named {
  id: string;
  name: string;
}

/** The ledger accounts money can sit in. */
function useAccounts(enabled = true) {
  return useList<Named & { accountType: string }>('ledger-accounts', '/books/accounts', enabled);
}

function useCategories(enabled = true) {
  return useList<Named & { kind: string }>('ledger-categories', '/books/categories', enabled);
}

/** The parent, siblings and children of this tenant — empty when it is not in a group. */
function useGroupEntities(enabled = true) {
  return useList<{ tenantId: string; slug: string; name: string }>('group-entities', '/books/group-entities', enabled);
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const transactionSchema = z.object({
  direction: z.enum(['in', 'out']),
  txnDate: z.string().min(1, 'Pick the date it happened'),
  amount: moneyField({ positive: true }),
  accountId: z.string().min(1, 'Choose the account it went through'),
  categoryId: z.string(),
  division: z.string(),
  counterparty: z.string(),
  reference: z.string(),
  note: z.string(),
  intercompanyTenantId: z.string(),
});

/**
 * A movement of money.
 *
 * Division is asked for rather than derived, because three businesses run
 * inside one legal entity and a transaction with no division cannot answer the
 * question the founder's dashboard exists to answer. The category's own
 * default fills it in, so the usual case is one click.
 */
export function NewTransaction({ open, onClose }: { open: boolean; onClose: () => void }) {
  const accounts = useAccounts(open);
  const categories = useCategories(open);
  const groupEntities = useGroupEntities(open);
  const form = useZodForm(transactionSchema, {
    direction: 'out',
    txnDate: today(),
    amount: '',
    accountId: '',
    categoryId: '',
    division: '',
    counterparty: '',
    reference: '',
    note: '',
    intercompanyTenantId: '',
  });
  const {
    register,
    formState: { errors },
  } = form;

  return (
    <CreateModal
      open={open}
      title="Record a movement of money"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['transactions'], ['cash'], ['books']]}
      form={form}
      onSubmit={(v) =>
        api.post('/books/transactions', {
          txnDate: v.txnDate,
          direction: v.direction,
          amount: rupeesOnWire(v.amount),
          accountId: v.accountId,
          categoryId: v.categoryId || null,
          division: v.division || null,
          counterparty: v.counterparty || null,
          reference: v.reference || null,
          note: v.note || null,
          intercompanyTenantId: v.intercompanyTenantId || null,
        })
      }
    >
      <Row>
        <Field label="Which way" required>
          {(c) => (
            <select className="input" required {...register('direction')} {...c}>
              <option value="out">Money out — we paid somebody</option>
              <option value="in">Money in — somebody paid us</option>
            </select>
          )}
        </Field>
        <Field label="Date" required error={errors.txnDate?.message}>
          {(c) => <input className="input" type="date" required {...register('txnDate')} {...c} />}
        </Field>
      </Row>
      <Row>
        <MoneyField label="Amount" required field={register('amount')} error={errors.amount?.message} />
        <Field label="Account" required error={errors.accountId?.message}>
          {(c) => (
            <select className="input" required {...register('accountId')} {...c}>
              <option value="">{accounts.rows.length ? 'Which account' : 'No accounts yet — add one first'}</option>
              {accounts.rows.map((a) => (
                <option key={a.id} value={a.id}>{`${a.name} (${a.accountType})`}</option>
              ))}
            </select>
          )}
        </Field>
      </Row>
      <Row>
        <Field label="What for">
          {(c) => (
            <select className="input" {...register('categoryId')} {...c}>
              <option value="">Uncategorised</option>
              {categories.rows.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Division" hint="which business">
          {(c) => (
            <select className="input" {...register('division')} {...c}>
              <option value="">From the category</option>
              {DIVISIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Row>
      <Row>
        <Field label="Who">
          {(c) => <input className="input" placeholder="Supplier or customer" {...register('counterparty')} {...c} />}
        </Field>
        <Field label="Reference">
          {(c) => <input className="input" placeholder="Cheque or UTR number" {...register('reference')} {...c} />}
        </Field>
      </Row>
      {groupEntities.rows.length > 0 && (
        <Field
          label="Group entity counterparty"
          hint="only when the other side is the holding or a sibling/child entity"
        >
          {(c) => (
            <select className="input" {...register('intercompanyTenantId')} {...c}>
              <option value="">Not inter-company</option>
              {groupEntities.rows.map((e) => (
                <option key={e.tenantId} value={e.tenantId}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <Field label="Note">{(c) => <textarea className="input" rows={2} {...register('note')} {...c} />}</Field>
    </CreateModal>
  );
}

const accountSchema = z.object({
  name: z.string().min(1, 'Give the account a name'),
  accountType: z.enum(['bank', 'cash', 'card', 'wallet', 'loan']),
  displayReference: z.string(),
  openingBalance: moneyField({ optional: true }),
  openingDate: z.string(),
});

export function NewLedgerAccount({ open, onClose }: { open: boolean; onClose: () => void }) {
  const form = useZodForm(accountSchema, {
    name: '',
    accountType: 'bank',
    displayReference: '',
    openingBalance: '0',
    openingDate: today(),
  });
  const {
    register,
    formState: { errors },
  } = form;

  return (
    <CreateModal
      open={open}
      title="Add an account"
      submitLabel="Add it"
      onClose={onClose}
      invalidate={[['ledger-accounts'], ['cash']]}
      form={form}
      onSubmit={(v) =>
        api.post('/books/accounts', {
          name: v.name,
          accountType: v.accountType,
          displayReference: v.displayReference || null,
          openingBalance: rupeesOnWire(v.openingBalance),
          openingDate: v.openingDate,
          ledgerGroup: v.accountType === 'card' || v.accountType === 'loan' ? 'liability' : 'asset',
        })
      }
    >
      <Field label="Name" required error={errors.name?.message}>
        {(c) => (
          <input
            className="input"
            autoFocus
            required
            placeholder="Current Account — Axis"
            {...register('name')}
            {...c}
          />
        )}
      </Field>
      <Row>
        <Field label="Kind" required error={errors.accountType?.message}>
          {(c) => (
            <select className="input" required {...register('accountType')} {...c}>
              <option value="bank">Bank account</option>
              <option value="cash">Cash box</option>
              <option value="card">Credit card</option>
              <option value="wallet">Wallet</option>
              <option value="loan">Loan account</option>
            </select>
          )}
        </Field>
        <Field label="Last four digits" hint="never the full number" error={errors.displayReference?.message}>
          {(c) => <input className="input" placeholder="4821" {...register('displayReference')} {...c} />}
        </Field>
      </Row>
      <Row>
        <MoneyField label="Opening balance" field={register('openingBalance')} error={errors.openingBalance?.message} />
        <Field label="As at" error={errors.openingDate?.message}>
          {(c) => <input className="input" type="date" {...register('openingDate')} {...c} />}
        </Field>
      </Row>
    </CreateModal>
  );
}

export function NewCategory({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('expense');
  const [behaviour, setBehaviour] = useState('variable');
  const [defaultDivision, setDefaultDivision] = useState('shared');

  return (
    <CreateModal
      open={open}
      title="Add a category"
      submitLabel="Add it"
      onClose={onClose}
      invalidate={[['ledger-categories']]}
      onSubmit={() => api.post('/books/categories', { name, kind, behaviour, defaultDivision })}
    >
      <TextInput label="Name" required autoFocus value={name} onChange={setName} placeholder="Building Rent" />
      <Row>
        <SelectInput
          label="Kind"
          required
          value={kind}
          onChange={setKind}
          options={[
            { value: 'expense', label: 'A cost' },
            { value: 'income', label: 'Revenue' },
            { value: 'asset_purchase', label: 'Something we bought and keep' },
            { value: 'tax', label: 'Tax or statutory due' },
            { value: 'transfer', label: 'Moving our own money' },
            { value: 'equity', label: 'Capital put in' },
            { value: 'drawings', label: 'Capital taken out' },
          ]}
        />
        <SelectInput
          label="How it behaves"
          hint="makes the budget forecastable"
          value={behaviour}
          onChange={setBehaviour}
          options={[
            { value: 'recurring_fixed', label: 'Same every month' },
            { value: 'variable', label: 'Varies' },
            { value: 'one_time', label: 'One-off' },
            { value: 'annual', label: 'Once a year' },
          ]}
        />
      </Row>
      <SelectInput
        label="Usually which division"
        value={defaultDivision}
        onChange={setDefaultDivision}
        options={DIVISIONS}
      />
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * The invoice form used to live here and now lives in `invoiceEditor.tsx`.
 *
 * It outgrew this file the moment an invoice could be edited as well as created,
 * carry tax priced per line, bill a person rather than only a company, and state
 * what is being paid at the counter. Keeping it beside the twenty-line forms
 * would have meant one of them was six hundred lines and the "these are all the
 * same shape" premise of this file was no longer true.
 */

const vendorBillSchema = z.object({
  vendorName: z.string().min(1, 'Name the supplier'),
  billNumber: z.string(),
  billDate: z.string().min(1, 'Pick the bill date'),
  dueDate: z.string(),
  subtotal: moneyField(),
  taxAmount: moneyField({ optional: true }),
  categoryId: z.string(),
  division: z.string(),
});

export function NewVendorBill({ open, onClose }: { open: boolean; onClose: () => void }) {
  const categories = useCategories(open);
  const form = useZodForm(vendorBillSchema, {
    vendorName: '',
    billNumber: '',
    billDate: today(),
    dueDate: '',
    subtotal: '',
    taxAmount: '',
    categoryId: '',
    division: 'shared',
  });
  const {
    register,
    formState: { errors },
  } = form;

  return (
    <CreateModal
      open={open}
      title="Record a bill we owe"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['vendor-bills'], ['payables']]}
      form={form}
      onSubmit={(v) =>
        api.post('/books/vendor-bills', {
          vendorName: v.vendorName,
          billNumber: v.billNumber || null,
          billDate: v.billDate,
          dueDate: v.dueDate || null,
          subtotal: rupeesOnWire(v.subtotal),
          taxAmount: rupeesOnWire(v.taxAmount),
          categoryId: v.categoryId || null,
          division: v.division,
        })
      }
    >
      <Row>
        <Field label="Supplier" required error={errors.vendorName?.message}>
          {(c) => <input className="input" autoFocus required {...register('vendorName')} {...c} />}
        </Field>
        <Field label="Their bill number">{(c) => <input className="input" {...register('billNumber')} {...c} />}</Field>
      </Row>
      <Row>
        <Field label="Bill date" required error={errors.billDate?.message}>
          {(c) => <input className="input" type="date" required {...register('billDate')} {...c} />}
        </Field>
        <Field label="Due by">{(c) => <input className="input" type="date" {...register('dueDate')} {...c} />}</Field>
      </Row>
      <Row>
        <MoneyField label="Amount before tax" required field={register('subtotal')} error={errors.subtotal?.message} />
        <MoneyField label="Tax" field={register('taxAmount')} error={errors.taxAmount?.message} />
      </Row>
      <Row>
        <Field label="What for">
          {(c) => (
            <select className="input" {...register('categoryId')} {...c}>
              <option value="">Uncategorised</option>
              {categories.rows.map((cat) => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Division">
          {(c) => (
            <select className="input" {...register('division')} {...c}>
              {DIVISIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Row>
    </CreateModal>
  );
}

const paymentSchema = z.object({
  amount: moneyField({ positive: true }),
  receivedAt: z.string().min(1, 'Pick the day it arrived'),
  method: z.string(),
  payerOrganizationId: z.string(),
  gatewayReference: z.string().min(1, 'Enter the UTR or cheque number'),
  note: z.string(),
});

export function NewPayment({ open, onClose }: { open: boolean; onClose: () => void }) {
  const organizations = useList<Named>('organizations', '/crm/organizations', open);
  const form = useZodForm(paymentSchema, {
    amount: '',
    receivedAt: today(),
    method: 'bank_transfer',
    payerOrganizationId: '',
    gatewayReference: '',
    note: '',
  });
  const {
    register,
    formState: { errors },
  } = form;

  return (
    <CreateModal
      open={open}
      title="Record a payment received"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['payments'], ['receivables'], ['invoices']]}
      form={form}
      onSubmit={(v) =>
        api.post('/finance/payments', {
          amount: rupeesOnWire(v.amount),
          receivedAt: v.receivedAt,
          method: v.method,
          payerOrganizationId: v.payerOrganizationId || null,
          gatewayReference: v.gatewayReference,
          note: v.note || null,
        })
      }
    >
      <Row>
        <MoneyField label="Amount" required field={register('amount')} error={errors.amount?.message} />
        <Field label="Received on" required error={errors.receivedAt?.message}>
          {(c) => <input className="input" type="date" required {...register('receivedAt')} {...c} />}
        </Field>
      </Row>
      <Row>
        <Field label="From">
          {(c) => (
            <select className="input" {...register('payerOrganizationId')} {...c}>
              <option value="">Not linked to a customer</option>
              {organizations.rows.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="How">
          {(c) => (
            <select className="input" {...register('method')} {...c}>
              <option value="bank_transfer">Bank transfer</option>
              <option value="upi">UPI</option>
              <option value="cheque">Cheque</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
            </select>
          )}
        </Field>
      </Row>
      <Field label="Reference" required error={errors.gatewayReference?.message}>
        {(c) => (
          <input
            className="input"
            required
            placeholder="UTR or cheque number"
            {...register('gatewayReference')}
            {...c}
          />
        )}
      </Field>
      <Field label="Note" hint="which invoice it settles is matched separately">
        {(c) => <textarea className="input" rows={2} {...register('note')} {...c} />}
      </Field>
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Customers and people
// ---------------------------------------------------------------------------

export function NewContact({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [fullName, setFullName] = useState('');
  const [primaryPhone, setPhone] = useState('');
  const [primaryEmail, setEmail] = useState('');
  const [notes, setNotes] = useState('');

  return (
    <CreateModal
      open={open}
      title="Add a contact"
      submitLabel="Add them"
      onClose={onClose}
      invalidate={[['people']]}
      onSubmit={() =>
        api.post('/crm/people', {
          fullName,
          primaryPhone: primaryPhone || null,
          primaryEmail: primaryEmail || null,
          notes: notes || null,
          source: 'manual',
        })
      }
    >
      <TextInput label="Name" required autoFocus value={fullName} onChange={setFullName} />
      <Row>
        <TextInput label="Phone" type="tel" value={primaryPhone} onChange={setPhone} />
        <TextInput label="Email" type="email" value={primaryEmail} onChange={setEmail} />
      </Row>
      <TextArea label="Notes" value={notes} onChange={setNotes} rows={2} />
      <p className="text-2xs text-ink-500">If this matches somebody on file, you will be asked first.</p>
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Organisations, and what they are to us
// ---------------------------------------------------------------------------

/**
 * A company, a college, or both.
 *
 * The old form asked for a name and then sent you to the record's own page to
 * press "Mark as a college", which filled in an institution type and a state
 * nobody had typed. Two things wrong with that: the person adding a college
 * knows it is a college while they are typing its name, and a product that
 * writes "Engineering college, Tamil Nadu" because nothing was asked is
 * inventing data in a system whose whole discipline is that absent is safe and
 * wrong is not.
 *
 * So the question is asked here, first, in one word — and the fields that
 * follow are the ones that answer actually needs. "Not sure yet" is a real
 * option, because sometimes you have a name off a business card and nothing
 * else, and forcing a guess would be the same bug in a different place.
 */

const INSTITUTION_TYPES = [
  { value: 'engineering_college', label: 'Engineering college' },
  { value: 'arts_science_college', label: 'Arts & science college' },
  { value: 'polytechnic', label: 'Polytechnic' },
  { value: 'university', label: 'University' },
  { value: 'school', label: 'School' },
  { value: 'iti', label: 'ITI' },
  { value: 'other', label: 'Other' },
];

const MANAGEMENT_TYPES = [
  { value: 'government', label: 'Government' },
  { value: 'aided', label: 'Aided' },
  { value: 'self_financing', label: 'Self-financing' },
  { value: 'autonomous', label: 'Autonomous' },
  { value: 'private', label: 'Private' },
];

const TIERS = [
  { value: 'strategic', label: 'Strategic' },
  { value: 'key', label: 'Key' },
  { value: 'standard', label: 'Standard' },
];

/** Billing detail. Either kind of body may carry it, so this is shared by both. */
function BillingFields(p: {
  tier: string;
  setTier: (v: string) => void;
  billingEmail: string;
  setBillingEmail: (v: string) => void;
  paymentTermsDays: string;
  setPaymentTermsDays: (v: string) => void;
}) {
  return (
    <Row>
      <SelectInput label="Tier" value={p.tier} onChange={p.setTier} placeholder="Not set" options={TIERS} />
      <TextInput
        label="Payment terms"
        type="number"
        hint="days"
        value={p.paymentTermsDays}
        onChange={p.setPaymentTermsDays}
        placeholder="30"
      />
      <TextInput label="Billing email" type="email" value={p.billingEmail} onChange={p.setBillingEmail} />
    </Row>
  );
}

/** The college-side fields, shared between creating one and marking one. */
function SchoolFields(p: {
  institutionType: string;
  setInstitutionType: (v: string) => void;
  managementType: string;
  setManagementType: (v: string) => void;
  district: string;
  setDistrict: (v: string) => void;
  state: string;
  setState: (v: string) => void;
  studentCount: string;
  setStudentCount: (v: string) => void;
}) {
  return (
    <>
      <Row>
        <SelectInput
          label="Kind of institution"
          value={p.institutionType}
          onChange={p.setInstitutionType}
          placeholder="Not recorded"
          options={INSTITUTION_TYPES}
        />
        <SelectInput
          label="Management"
          value={p.managementType}
          onChange={p.setManagementType}
          placeholder="Not recorded"
          options={MANAGEMENT_TYPES}
        />
      </Row>
      <Row>
        <TextInput label="District" value={p.district} onChange={p.setDistrict} />
        <TextInput label="State" value={p.state} onChange={p.setState} />
      </Row>
      <TextInput
        label="Students on campus"
        type="number"
        hint="roughly, if known — leave blank rather than guessing"
        value={p.studentCount}
        onChange={p.setStudentCount}
      />
    </>
  );
}

function useBodyFields() {
  const [tier, setTier] = useState('');
  const [billingEmail, setBillingEmail] = useState('');
  const [paymentTermsDays, setPaymentTermsDays] = useState('');
  const [institutionType, setInstitutionType] = useState('');
  const [managementType, setManagementType] = useState('');
  const [district, setDistrict] = useState('');
  const [state, setState] = useState('');
  const [studentCount, setStudentCount] = useState('');

  // Only what was actually typed is sent. A blank field is left out of the
  // payload entirely rather than sent as an empty string, so "not recorded"
  // stays distinguishable from "recorded as nothing".
  const account = () => ({
    ...(tier ? { tier } : {}),
    ...(billingEmail ? { billingEmail } : {}),
    ...(paymentTermsDays ? { paymentTermsDays: Number(paymentTermsDays) } : {}),
  });

  const institutionProfile = () => ({
    ...(institutionType ? { institutionType } : {}),
    ...(managementType ? { managementType } : {}),
    ...(district ? { district } : {}),
    ...(state ? { state } : {}),
    ...(studentCount ? { studentCount: Number(studentCount) } : {}),
  });

  return {
    account,
    institutionProfile,
    billingProps: { tier, setTier, billingEmail, setBillingEmail, paymentTermsDays, setPaymentTermsDays },
    schoolProps: {
      institutionType,
      setInstitutionType,
      managementType,
      setManagementType,
      district,
      setDistrict,
      state,
      setState,
      studentCount,
      setStudentCount,
    },
  };
}

/** What an institution's own page shows back, for pre-filling its edit. */
interface EditableInstitution {
  id: string;
  name: string;
  website: string | null;
  institutionProfile: {
    institutionType: string | null;
    managementType: string | null;
    district: string | null;
    state: string | null;
    studentCount: number | null;
    accreditation: string | null;
    engagements: string[];
  } | null;
}

/**
 * Add a school or a college — or correct one already on file.
 *
 * With `institution` given, the organisation-level fields and (where a
 * profile already exists) the school-level fields are pre-filled and saved as
 * two PATCH requests, since they live on two different tables. Where there is
 * no profile yet, those fields are left off the form entirely rather than
 * shown and then silently dropped: adding the first one is `AddSchoolDetails`'s
 * job.
 */
export function NewInstitution({
  open,
  onClose,
  institution,
}: {
  open: boolean;
  onClose: () => void;
  institution?: EditableInstitution | null;
}) {
  const editing = Boolean(institution);
  const hasProfile = !editing || Boolean(institution?.institutionProfile);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [billed, setBilled] = useState(false);
  const [engagements, setEngagements] = useState<InstitutionEngagement[]>([]);
  const [accreditation, setAccreditation] = useState('');
  const f = useBodyFields();

  useEffect(() => {
    if (!open) return;
    setName(institution?.name ?? '');
    setWebsite(institution?.website ?? '');
    const profile = institution?.institutionProfile;
    setEngagements((profile?.engagements as InstitutionEngagement[]) ?? []);
    setAccreditation(profile?.accreditation ?? '');
    f.schoolProps.setInstitutionType(profile?.institutionType ?? '');
    f.schoolProps.setManagementType(profile?.managementType ?? '');
    f.schoolProps.setDistrict(profile?.district ?? '');
    f.schoolProps.setState(profile?.state ?? '');
    f.schoolProps.setStudentCount(profile?.studentCount ? String(profile.studentCount) : '');
    // f's setters are stable across renders; re-running this on every render
    // of f would fight with what somebody is typing.
  }, [open, institution]);

  const toggle = (e: InstitutionEngagement) =>
    setEngagements((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));

  const profileBody = () => ({ ...f.institutionProfile(), engagements, accreditation: accreditation || null });

  return (
    <CreateModal
      open={open}
      title={editing ? `Edit ${institution!.name}` : 'Add a school or a college'}
      submitLabel={editing ? 'Save' : 'Add it'}
      onClose={onClose}
      invalidate={editing ? [['organization', institution!.id], ['institutions']] : [['institutions']]}
      onSubmit={async () => {
        if (editing) {
          await api.patch(`/crm/organizations/${institution!.id}`, { name, website: website || null });
          if (hasProfile) await api.patch(`/crm/institutions/${institution!.id}/school-details`, profileBody());
          return;
        }
        return api.post('/crm/institutions', {
          name,
          website: website || null,
          institutionProfile: profileBody(),
          ...(billed ? { account: f.account() } : {}),
        });
      }}
    >
      {!editing && (
        <p className="text-2xs text-ink-500">
          Somewhere learners come to us from. Students name it as where they studied, and its page then answers how many
          it has sent and how they did.
        </p>
      )}
      <TextInput label="Name" required autoFocus value={name} onChange={setName} />
      <TextInput label="Website" value={website} onChange={setWebsite} placeholder="https://" />

      {hasProfile && (
        <>
          <SchoolFields {...f.schoolProps} />
          <TextInput
            label="Accreditation"
            value={accreditation}
            onChange={setAccreditation}
            placeholder="NAAC A+, NBA, autonomous…"
          />

          {/* A college is not one relationship. Which of the five depths this
              partnership actually runs at is the thing a partnership recorded only
              as "active" never says. */}
          <fieldset className="rounded-lg border border-ink-800 p-3">
            <legend className="px-1 text-2xs uppercase tracking-wide text-ink-500">What we do with them</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {INSTITUTION_ENGAGEMENTS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => toggle(e)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    engagements.includes(e) ? 'border-accent/60 bg-accent/10' : 'border-ink-800 hover:border-ink-600'
                  }`}
                >
                  <span
                    className={`block text-xs font-medium ${
                      engagements.includes(e) ? 'text-accent-soft' : 'text-ink-200'
                    }`}
                  >
                    {INSTITUTION_ENGAGEMENT_LABELS[e]}
                  </span>
                  <span className="block text-2xs text-ink-500">{INSTITUTION_ENGAGEMENT_HINTS[e]}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 px-1 text-2xs text-ink-500">As many as are true. None yet is a fine answer.</p>
          </fieldset>
        </>
      )}

      {!editing && (
        <>
          {/* Billing is not what makes a body one kind or the other: a
              polytechnic that buys a staff programme is invoiced like anyone
              else and stays a college. */}
          <label className="flex items-start gap-2 rounded-lg border border-ink-800 p-3">
            <input type="checkbox" className="mt-0.5" checked={billed} onChange={(e) => setBilled(e.target.checked)} />
            <span>
              <span className="block text-xs text-ink-200">We invoice them too</span>
              <span className="block text-2xs text-ink-500">
                Payment terms and a billing address. It stays a college.
              </span>
            </span>
          </label>
          {billed && (
            <fieldset className="rounded-lg border border-ink-800 p-3">
              <legend className="px-1 text-2xs uppercase tracking-wide text-ink-500">Billing</legend>
              <BillingFields {...f.billingProps} />
            </fieldset>
          )}
        </>
      )}
    </CreateModal>
  );
}

/** What an organisation's own page shows back, for pre-filling its edit. */
interface EditableOrganization {
  id: string;
  name: string;
  website: string | null;
  roles: string[];
}

/**
 * Add an organisation — or correct one already on file.
 *
 * With `organization` given, only the name and website are edited here: what
 * the body *is to us* has its own dedicated `PUT .../roles` and its own
 * picker on the record's own page, and billing is `AddBillingDetails`'s. An
 * edit that showed the roles picker but only ever sent name and website would
 * silently drop a change somebody made in it, so it is left off the form
 * entirely in edit mode rather than shown and ignored.
 */
export function NewOrganization({
  open,
  onClose,
  organization,
}: {
  open: boolean;
  onClose: () => void;
  organization?: EditableOrganization | null;
}) {
  const editing = Boolean(organization);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [billed, setBilled] = useState(true);
  const [roles, setRoles] = useState<OrganizationRole[]>(['client']);
  const f = useBodyFields();

  useEffect(() => {
    if (!open) return;
    setName(organization?.name ?? '');
    setWebsite(organization?.website ?? '');
  }, [open, organization]);

  const toggle = (r: OrganizationRole) =>
    setRoles((prev) => (prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]));

  return (
    <CreateModal
      open={open}
      title={editing ? `Edit ${organization!.name}` : 'Add an organisation'}
      submitLabel={editing ? 'Save' : 'Add it'}
      onClose={onClose}
      invalidate={editing ? [['organization', organization!.id], ['organizations']] : [['organizations']]}
      onSubmit={() =>
        editing
          ? api.patch(`/crm/organizations/${organization!.id}`, { name, website: website || null })
          : api.post('/crm/organizations', {
              name,
              website: website || null,
              roles,
              ...(billed ? { account: f.account() } : {}),
            })
      }
    >
      {editing ? (
        <p className="text-2xs text-ink-500">
          What they are to us and how we bill them are edited from their own place on the record.
        </p>
      ) : (
        <p className="text-2xs text-ink-500">
          A business, trust or foundation. Schools and colleges go under Institutions.
        </p>
      )}
      <TextInput label="Name" required autoFocus value={name} onChange={setName} />
      <TextInput label="Website" value={website} onChange={setWebsite} placeholder="https://" />

      {!editing && (
        <>
          {/* What they do with us, which is a different question from what
              they are — and not exclusive. A manufacturer that funds a CSR
              cohort and hires out of it is both, and recording one loses the
              half somebody is about to ask about. */}
          <fieldset className="rounded-lg border border-ink-800 p-3">
            <legend className="px-1 text-2xs uppercase tracking-wide text-ink-500">What they are to us</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ORGANIZATION_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => toggle(r)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                    roles.includes(r) ? 'border-accent/60 bg-accent/10' : 'border-ink-800 hover:border-ink-600'
                  }`}
                >
                  <span
                    className={`block text-xs font-medium ${roles.includes(r) ? 'text-accent-soft' : 'text-ink-200'}`}
                  >
                    {ORGANIZATION_ROLE_LABELS[r]}
                  </span>
                  <span className="block text-2xs text-ink-500">{ORGANIZATION_ROLE_HINTS[r]}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 px-1 text-2xs text-ink-500">As many as are true.</p>
          </fieldset>

          <label className="flex items-start gap-2 rounded-lg border border-ink-800 p-3">
            <input type="checkbox" className="mt-0.5" checked={billed} onChange={(e) => setBilled(e.target.checked)} />
            <span>
              <span className="block text-xs text-ink-200">We invoice them</span>
              <span className="block text-2xs text-ink-500">
                Payment terms and a billing address. Add it later if you would rather.
              </span>
            </span>
          </label>
          {billed && (
            <fieldset className="rounded-lg border border-ink-800 p-3">
              <legend className="px-1 text-2xs uppercase tracking-wide text-ink-500">Billing</legend>
              <BillingFields {...f.billingProps} />
            </fieldset>
          )}
        </>
      )}
    </CreateModal>
  );
}

/**
 * Billing detail for a body already on file, of either kind.
 *
 * With `existing` given, the fields are pre-filled from it and saved with a
 * PATCH; with none, this is the first billing detail the body has had and is
 * created with a POST.
 */
export function AddBillingDetails({
  open,
  organizationId,
  name,
  onClose,
  queryKey,
  existing,
}: {
  open: boolean;
  organizationId: string;
  name: string;
  onClose: () => void;
  queryKey: string;
  existing?: { tier: string | null; billingEmail: string | null; paymentTermsDays: number | null } | null;
}) {
  const editing = Boolean(existing);
  const f = useBodyFields();

  useEffect(() => {
    if (!open) return;
    f.billingProps.setTier(existing?.tier ?? '');
    f.billingProps.setBillingEmail(existing?.billingEmail ?? '');
    f.billingProps.setPaymentTermsDays(existing?.paymentTermsDays ? String(existing.paymentTermsDays) : '');
  }, [open, existing]);

  return (
    <CreateModal
      open={open}
      title={`How we bill ${name}`}
      submitLabel="Save"
      onClose={onClose}
      invalidate={[['organization', organizationId], [queryKey]]}
      onSubmit={() => {
        const path = `/crm/organizations/${organizationId}/account`;
        return editing ? api.patch(path, f.account()) : api.post(path, f.account());
      }}
    >
      <p className="text-2xs text-ink-500">Everything below is optional.</p>
      <BillingFields {...f.billingProps} />
    </CreateModal>
  );
}

/**
 * School and college detail for an institution already on file.
 *
 * With `existing` given, the fields are pre-filled from it and saved with a
 * PATCH; with none, this is the first school detail the institution has had
 * and is created with a POST.
 */
export function AddSchoolDetails({
  open,
  organizationId,
  name,
  onClose,
  existing,
}: {
  open: boolean;
  organizationId: string;
  name: string;
  onClose: () => void;
  existing?: {
    institutionType: string | null;
    managementType: string | null;
    district: string | null;
    state: string | null;
    studentCount: number | null;
  } | null;
}) {
  const editing = Boolean(existing);
  const f = useBodyFields();

  useEffect(() => {
    if (!open) return;
    f.schoolProps.setInstitutionType(existing?.institutionType ?? '');
    f.schoolProps.setManagementType(existing?.managementType ?? '');
    f.schoolProps.setDistrict(existing?.district ?? '');
    f.schoolProps.setState(existing?.state ?? '');
    f.schoolProps.setStudentCount(existing?.studentCount ? String(existing.studentCount) : '');
  }, [open, existing]);

  return (
    <CreateModal
      open={open}
      title={`What kind of place ${name} is`}
      submitLabel="Save"
      onClose={onClose}
      invalidate={[['organization', organizationId], ['institutions']]}
      onSubmit={() => {
        const path = `/crm/institutions/${organizationId}/school-details`;
        return editing ? api.patch(path, f.institutionProfile()) : api.post(path, f.institutionProfile());
      }}
    >
      <p className="text-2xs text-ink-500">All optional.</p>
      <SchoolFields {...f.schoolProps} />
    </CreateModal>
  );
}

const STUDENT_STATUSES = [
  { value: 'prospective', label: 'Enquiring' },
  { value: 'active', label: 'On a course' },
  { value: 'alumni', label: 'Finished' },
  { value: 'withdrawn', label: 'Left' },
];

/** The fields a student's record already carries, as read back off the record. */
interface EditableStudent {
  id: string;
  fullName: string;
  primaryPhone: string | null;
  primaryEmail: string | null;
  registrationNumber: string | null;
  institution: { id: string } | null;
  placeOfSupply: string | null;
  address: string | null;
  status: string;
  funding: string;
  sponsor: { id: string } | null;
  fundingFramework: string | null;
  deliveryLocation: string | null;
}

/**
 * A student: an individual who takes a course and is billed in their own name.
 *
 * Not an organisation with one person in it, which is what the product used to
 * make somebody type in order to raise a walk-in's invoice.
 *
 * Also the correction path for one arriving wrong out of a bulk import: with
 * `student` given, the same fields are pre-filled from the record and saved
 * with a PATCH rather than a POST.
 */
export function NewStudent({
  open,
  onClose,
  student,
}: {
  open: boolean;
  onClose: () => void;
  student?: EditableStudent | null;
}) {
  const editing = Boolean(student);
  const [fullName, setFullName] = useState('');
  const [primaryPhone, setPhone] = useState('');
  const [primaryEmail, setEmail] = useState('');
  const [registrationNumber, setRegistration] = useState('');
  const [institutionId, setInstitution] = useState('');
  const [placeOfSupply, setPlaceOfSupply] = useState('');
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState('prospective');
  const [funding, setFunding] = useState<FundingSource>('self');
  const [sponsorId, setSponsor] = useState('');
  const [fundingFramework, setFramework] = useState('');
  const [deliveryLocation, setLocation] = useState('');
  // Only a new student carries an age basis: the edit form's record has no date
  // of birth to show, and changing one is not part of editing a profile. FX-64.
  const [age, setAge] = useState<AgeBasisValues>({
    dateOfBirth: '',
    adultAttested: false,
    guardianName: '',
    guardianPhone: '',
  });

  useEffect(() => {
    if (!open) return;
    setFullName(student?.fullName ?? '');
    setPhone(student?.primaryPhone ?? '');
    setEmail(student?.primaryEmail ?? '');
    setRegistration(student?.registrationNumber ?? '');
    setInstitution(student?.institution?.id ?? '');
    setPlaceOfSupply(student?.placeOfSupply ?? '');
    setAddress(student?.address ?? '');
    setStatus(student?.status ?? 'prospective');
    setFunding((student?.funding as FundingSource) ?? 'self');
    setSponsor(student?.sponsor?.id ?? '');
    setFramework(student?.fundingFramework ?? '');
    setLocation(student?.deliveryLocation ?? '');
    setAge({ dateOfBirth: '', adultAttested: false, guardianName: '', guardianPhone: '' });
  }, [open, student]);

  const { data: institutions } = useQuery({
    queryKey: ['institutions', 'picker'],
    queryFn: () => api.get<{ items: Array<{ id: string; name: string }> }>('/crm/institutions?pageSize=100'),
    enabled: open,
    retry: false,
  });

  // Only bodies that fund cohorts are offered as sponsors, so the list is short
  // and the right one is in it.
  const { data: sponsors } = useQuery({
    queryKey: ['organizations', 'sponsors'],
    queryFn: () =>
      api.get<{ items: Array<{ id: string; name: string }> }>('/crm/organizations?pageSize=100&role=sponsor'),
    enabled: open && funding === 'sponsor',
    retry: false,
  });

  const body = () => ({
    fullName,
    primaryPhone: primaryPhone || null,
    primaryEmail: primaryEmail || null,
    registrationNumber: registrationNumber || null,
    institutionId: institutionId || null,
    placeOfSupply: placeOfSupply || null,
    address: address || null,
    status,
    funding,
    sponsorId: funding === 'sponsor' ? sponsorId || null : null,
    fundingFramework: funding === 'scheme' ? fundingFramework || null : null,
    deliveryLocation: deliveryLocation || null,
    ...(editing ? {} : ageBasisBody(age)),
  });

  return (
    <CreateModal
      open={open}
      title={editing ? `Edit ${student!.fullName}` : 'Add a student'}
      submitLabel={editing ? 'Save' : 'Add them'}
      onClose={onClose}
      invalidate={editing ? [['student', student!.id], ['students']] : [['students']]}
      onSubmit={() => (editing ? api.patch(`/crm/students/${student!.id}`, body()) : api.post('/crm/students', body()))}
    >
      <TextInput label="Name" required autoFocus value={fullName} onChange={setFullName} />
      <Row>
        <TextInput label="Phone" value={primaryPhone} onChange={setPhone} placeholder="10 digits" />
        <TextInput label="Email" value={primaryEmail} onChange={setEmail} />
      </Row>
      <p className="text-2xs text-ink-500">One of the two is needed, so somebody already on file is recognised.</p>
      {!editing && <AgeBasisFields values={age} onChange={setAge} />}
      <Row>
        <TextInput
          label="Registration number"
          value={registrationNumber}
          onChange={setRegistration}
          placeholder="KI-2026/09-SAP/1107"
        />
        <SelectInput label="Where they are up to" value={status} onChange={setStatus} options={STUDENT_STATUSES} />
      </Row>
      <Row>
        <SelectInput
          label="College they came from"
          value={institutionId}
          onChange={setInstitution}
          placeholder="None — they came to us directly"
          options={(institutions?.items ?? []).map((i) => ({ value: i.id, label: i.name }))}
        />
        <SelectInput
          label="Where they are taught"
          value={deliveryLocation}
          onChange={setLocation}
          placeholder="Not decided"
          options={DELIVERY_LOCATIONS.map((l) => ({ value: l, label: DELIVERY_LOCATION_LABELS[l] }))}
        />
      </Row>

      {/* Who is paying. The most consequential answer on the form: a learner on
          a funded cohort owes nothing, and an invoice raised to them is a
          document that should never have existed. */}
      <fieldset className="space-y-3 rounded-lg border border-ink-800 p-3">
        <legend className="px-1 text-2xs uppercase tracking-wide text-ink-500">Who is paying</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {FUNDING_SOURCES.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFunding(f)}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                funding === f ? 'border-accent/60 bg-accent/10' : 'border-ink-800 hover:border-ink-600'
              }`}
            >
              <span className={`block text-xs font-medium ${funding === f ? 'text-accent-soft' : 'text-ink-200'}`}>
                {FUNDING_SOURCE_LABELS[f]}
              </span>
            </button>
          ))}
        </div>

        {funding === 'sponsor' && (
          <SelectInput
            label="The organisation paying"
            required
            value={sponsorId}
            onChange={setSponsor}
            placeholder={
              sponsors?.items?.length ? 'Choose the sponsor' : 'No organisation is marked as funding cohorts yet'
            }
            options={(sponsors?.items ?? []).map((o) => ({ value: o.id, label: o.name }))}
          />
        )}
        {funding === 'scheme' && (
          <SelectInput
            label="Under which framework"
            required
            value={fundingFramework}
            onChange={setFramework}
            placeholder="Choose the scheme"
            options={FUNDING_FRAMEWORKS.map((f) => ({ value: f, label: FUNDING_FRAMEWORK_LABELS[f] }))}
          />
        )}
        {funding === 'institution' && <p className="text-2xs text-ink-500">Their college pays — name it above.</p>}
        {funding !== 'self' && (
          <p className="text-2xs text-ink-500">No invoice goes to them. The fee is billed to whoever pays.</p>
        )}
      </fieldset>

      {funding === 'self' && (
        <>
          <Row>
            <TextInput label="State" value={placeOfSupply} onChange={setPlaceOfSupply} placeholder="33 — Tamil Nadu" />
            <TextInput label="Address" value={address} onChange={setAddress} />
          </Row>
          <p className="text-2xs text-ink-500">The state decides how their tax splits.</p>
        </>
      )}
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// What we sell, and how it is sold
// ---------------------------------------------------------------------------

const VERTICALS = [
  { value: 'software_ai', label: 'Software & AI' },
  { value: 'cybersecurity', label: 'Cybersecurity' },
  { value: 'sap_enterprise', label: 'SAP / Enterprise' },
  { value: 'corporate_training', label: 'Corporate training' },
  { value: 'education', label: 'Education' },
  { value: 'placement', label: 'Placement' },
  { value: 'partnerships', label: 'Partnerships' },
  { value: 'research', label: 'Research' },
];

export function NewOffering({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [offeringCode, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [vertical, setVertical] = useState('software_ai');
  const [deliveryModel, setDeliveryModel] = useState('professional_services');
  const [defaultRevenueTreatment, setRevenue] = useState('point_in_time');

  return (
    <CreateModal
      open={open}
      title="Add something we sell"
      submitLabel="Add it"
      onClose={onClose}
      invalidate={[['offerings']]}
      onSubmit={() =>
        api.post('/commercial/offerings', {
          offeringCode:
            offeringCode ||
            name
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, '-')
              .slice(0, 20),
          name,
          description: description || null,
          vertical,
          deliveryModel,
          defaultRevenueTreatment,
        })
      }
    >
      <Row>
        <TextInput label="Name" required autoFocus value={name} onChange={setName} placeholder="Managed SOC" />
        <TextInput label="Code" hint="made from the name if left blank" value={offeringCode} onChange={setCode} />
      </Row>
      <TextArea label="What it is" value={description} onChange={setDescription} rows={2} />
      <Row>
        <SelectInput label="Which business" required value={vertical} onChange={setVertical} options={VERTICALS} />
        <SelectInput
          label="How it is delivered"
          required
          value={deliveryModel}
          onChange={setDeliveryModel}
          options={[
            { value: 'professional_services', label: 'A project we deliver' },
            { value: 'saas_subscription', label: 'A subscription' },
            { value: 'cohort', label: 'A batch of learners' },
            { value: 'placement_fee', label: 'A placement fee' },
          ]}
        />
      </Row>
      <SelectInput
        label="When it counts as revenue"
        hint="decided here once, never deal by deal"
        required
        value={defaultRevenueTreatment}
        onChange={setRevenue}
        options={[
          { value: 'point_in_time', label: 'All at once, when delivered' },
          { value: 'over_time_ratable', label: 'Spread across the term' },
          { value: 'milestone_based', label: 'At each milestone' },
        ]}
      />
      <p className="text-2xs text-ink-500">Set once here, so nobody decides it deal by deal.</p>
    </CreateModal>
  );
}

/** A call, a meeting, a note — the record of having talked to somebody. */
export function NewInteraction({ open, onClose }: { open: boolean; onClose: () => void }) {
  const organizations = useList<Named>('organizations', '/crm/organizations', open);

  const [interactionType, setType] = useState('call');
  const [direction, setDirection] = useState('outbound');
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 16));
  const [subject, setSubject] = useState('');
  const [notes, setNotes] = useState('');
  const [entityId, setEntityId] = useState('');
  const [durationMinutes, setDuration] = useState('');

  return (
    <CreateModal
      open={open}
      title="Log a call or meeting"
      submitLabel="Log it"
      onClose={onClose}
      invalidate={[['interactions']]}
      onSubmit={() =>
        api.post('/crm/interactions', {
          interactionType,
          direction,
          occurredAt: new Date(occurredAt).toISOString(),
          subject,
          notes: notes || null,
          durationMinutes: durationMinutes ? Number(durationMinutes) : null,
          ...(entityId
            ? {
                contextCode: 'crm',
                entityType: 'organization',
                entityId,
                displayLabel: organizations.rows.find((o) => o.id === entityId)?.name ?? null,
              }
            : {}),
        })
      }
    >
      <Row>
        <SelectInput
          label="What it was"
          required
          value={interactionType}
          onChange={setType}
          options={[
            { value: 'call', label: 'Call' },
            { value: 'meeting', label: 'Meeting' },
            { value: 'email', label: 'Email' },
            { value: 'note', label: 'Note' },
            { value: 'site_visit', label: 'Site visit' },
          ]}
        />
        <SelectInput
          label="Which way"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'outbound', label: 'We reached out' },
            { value: 'inbound', label: 'They reached us' },
            { value: 'internal', label: 'Internal' },
          ]}
        />
      </Row>
      <Row>
        <TextInput
          label="When"
          type="text"
          required
          value={occurredAt}
          onChange={setOccurredAt}
          hint="YYYY-MM-DDTHH:MM"
        />
        <TextInput label="How long (minutes)" type="number" value={durationMinutes} onChange={setDuration} />
      </Row>
      <TextInput label="Subject" required value={subject} onChange={setSubject} placeholder="Renewal discussion" />
      <SelectInput
        label="Who with"
        value={entityId}
        onChange={setEntityId}
        placeholder="Not linked to a customer"
        options={organizations.rows.map((o) => ({ value: o.id, label: o.name }))}
      />
      <TextArea label="What was said" value={notes} onChange={setNotes} rows={3} />
      <p className="text-2xs text-ink-500">Sensitivity follows what it is attached to.</p>
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Assets, loans and the budget
// ---------------------------------------------------------------------------

const assetSchema = z.object({
  name: z.string().min(1, 'Name the thing you bought'),
  purchaseDate: z.string().min(1, 'Pick the day you bought it'),
  cost: moneyField({ positive: true }),
  usefulLifeMonths: z.coerce.number().int('Enter whole months').positive('Enter how many months it lasts'),
  salvageValue: moneyField({ optional: true }),
  method: z.enum(['straight_line', 'wdv']),
  division: z.string(),
});

export function NewAsset({ open, onClose }: { open: boolean; onClose: () => void }) {
  const form = useZodForm(assetSchema, {
    name: '',
    purchaseDate: today(),
    cost: '',
    usefulLifeMonths: 60,
    salvageValue: '0',
    method: 'straight_line',
    division: 'shared',
  });
  const {
    register,
    formState: { errors },
  } = form;

  return (
    <CreateModal
      open={open}
      title="Record something we bought and keep"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['assets']]}
      form={form}
      onSubmit={(v) =>
        api.post('/books/assets', {
          name: v.name,
          purchaseDate: v.purchaseDate,
          cost: rupeesOnWire(v.cost),
          salvageValue: rupeesOnWire(v.salvageValue),
          usefulLifeMonths: v.usefulLifeMonths,
          method: v.method,
          division: v.division,
        })
      }
    >
      <Field label="What it is" required error={errors.name?.message}>
        {(c) => (
          <input className="input" autoFocus required placeholder="Air conditioner" {...register('name')} {...c} />
        )}
      </Field>
      <Row>
        <MoneyField label="What it cost" required field={register('cost')} error={errors.cost?.message} />
        <Field label="Bought on" required error={errors.purchaseDate?.message}>
          {(c) => <input className="input" type="date" required {...register('purchaseDate')} {...c} />}
        </Field>
      </Row>
      <Row>
        <Field label="Useful life (months)" hint="60 is five years" required error={errors.usefulLifeMonths?.message}>
          {(c) => <input className="input" type="number" required {...register('usefulLifeMonths')} {...c} />}
        </Field>
        <MoneyField label="Worth at the end" field={register('salvageValue')} error={errors.salvageValue?.message} />
      </Row>
      <Row>
        <Field label="How it depreciates">
          {(c) => (
            <select className="input" {...register('method')} {...c}>
              <option value="straight_line">Straight line — the same each month</option>
              <option value="wdv">Written down value — more at the start</option>
            </select>
          )}
        </Field>
        <Field label="Division">
          {(c) => (
            <select className="input" {...register('division')} {...c}>
              {DIVISIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Row>
    </CreateModal>
  );
}

export function NewLoan({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [lender, setLender] = useState('');
  const [principal, setPrincipal] = useState('');
  const [annualRate, setRate] = useState('');
  const [tenureMonths, setTenure] = useState('36');
  const [startDate, setStart] = useState(today());
  const [division, setDivision] = useState('shared');

  return (
    <CreateModal
      open={open}
      title="Record a borrowing"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['loans']]}
      onSubmit={() =>
        api.post('/books/loans', {
          lender,
          principal: Number(principal),
          annualRate: Number(annualRate),
          tenureMonths: Number(tenureMonths),
          startDate,
          division,
        })
      }
    >
      <TextInput label="Who from" required autoFocus value={lender} onChange={setLender} placeholder="Axis Bank" />
      <Row>
        <MoneyInput label="How much" required value={principal} onChange={setPrincipal} />
        <TextInput
          label="Rate (% a year)"
          type="number"
          required
          value={annualRate}
          onChange={setRate}
          placeholder="11.5"
        />
      </Row>
      <Row>
        <TextInput label="Over (months)" type="number" required value={tenureMonths} onChange={setTenure} />
        <TextInput label="From" type="date" required value={startDate} onChange={setStart} />
      </Row>
      <SelectInput label="Division" value={division} onChange={setDivision} options={DIVISIONS} />
      <p className="text-2xs text-ink-500">The repayment schedule is worked out from these four numbers.</p>
    </CreateModal>
  );
}

const budgetLineSchema = z.object({
  categoryId: z.string().min(1, 'Choose the category this is for'),
  amount: moneyField(),
  division: z.string(),
  note: z.string(),
});

export function NewBudgetLine({ open, onClose, period }: { open: boolean; onClose: () => void; period: string }) {
  const categories = useCategories(open);
  const form = useZodForm(budgetLineSchema, {
    categoryId: '',
    amount: '',
    division: 'shared',
    note: '',
  });
  const {
    register,
    formState: { errors },
  } = form;

  return (
    <CreateModal
      open={open}
      title={`Budget for ${period}`}
      submitLabel="Set it"
      onClose={onClose}
      invalidate={[['budget'], ['budget-variance']]}
      form={form}
      onSubmit={(v) =>
        api.post('/books/budget', {
          period,
          categoryId: v.categoryId,
          amount: rupeesOnWire(v.amount),
          division: v.division,
          note: v.note || null,
        })
      }
    >
      <Field label="What for" required error={errors.categoryId?.message}>
        {(c) => (
          <select className="input" required {...register('categoryId')} {...c}>
            <option value="">{categories.rows.length ? 'Choose a category' : 'No categories yet'}</option>
            {categories.rows.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Row>
        <MoneyField label="Planned" required field={register('amount')} error={errors.amount?.message} />
        <Field label="Division">
          {(c) => (
            <select className="input" {...register('division')} {...c}>
              {DIVISIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </Field>
      </Row>
      <Field label="Why this number">
        {(c) => <textarea className="input" rows={2} {...register('note')} {...c} />}
      </Field>
      <p className="text-2xs text-ink-500">Spend is summed when you look, so a late entry moves the variance.</p>
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export function NewSkill({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [halfLifeMonths, setHalfLife] = useState('24');

  return (
    <CreateModal
      open={open}
      title="Add a skill"
      submitLabel="Add it"
      onClose={onClose}
      invalidate={[['skills']]}
      onSubmit={() => api.post('/hr/skills', { name, halfLifeMonths: Number(halfLifeMonths) })}
    >
      <TextInput label="Skill" required autoFocus value={name} onChange={setName} placeholder="Kubernetes" />
      <TextInput
        label="Half-life (months)"
        type="number"
        value={halfLifeMonths}
        onChange={setHalfLife}
        hint="how fast it goes stale unaided"
      />
      <p className="text-2xs text-ink-500">Confidence fades from this date.</p>
    </CreateModal>
  );
}

/** A blank text field for a regulated identifier means "leave it as it is",
 * never "clear it" — so it is left out of the PATCH body entirely rather than
 * sent as an empty string, which the API would read as a write. */
function orUndefined(value: string): string | undefined {
  return value.trim() ? value : undefined;
}

/** "On file, ending 1234" when HR's read-back names the last four; "On file"
 * when it is there but withheld; blank when there is nothing on file yet. */
function onFileHint(has: boolean, last4?: string | null): string | undefined {
  if (!has) return undefined;
  return last4
    ? `On file, ending ${last4} — enter a new value to replace it`
    : 'On file — enter a new value to replace it';
}

/**
 * Everything about an employee that the platform's own rules let this viewer
 * change: their personal details always, and — only when the read already
 * carried the HR-only fields (`canEditEmploymentDetails`, set by
 * `employees:edit@all`) — the employment relationship's dates, terms and
 * statutory identifiers.
 *
 * Salary and where they sit are never in this form. Both have their own
 * lifecycle (`ProposeCompensation` below; the assignment workflow on "Where
 * they sit"), and a field here that moved either would let it happen without
 * the approval or the record either one is built to leave behind.
 *
 * Every regulated field — blood group, PAN, UAN, ESIC number, bank details —
 * is write-only: the read that fills this form in never carries the stored
 * value, only whether one exists (`has*`) and, for HR, its last four
 * characters. Leaving the field blank leaves the stored value alone.
 */
export function EditEmployeeProfile({
  open,
  onClose,
  employmentId,
  person,
  employment,
  canEditEmploymentDetails,
}: {
  open: boolean;
  onClose: () => void;
  employmentId: string;
  person: {
    fullName: string;
    primaryPhone: string | null;
    primaryEmail: string | null;
    dateOfBirth?: string | null;
    hasBloodGroup?: boolean;
  };
  employment?: {
    hireEffectiveDate: string;
    noticePeriodDays: number;
    engagementType: string;
    emergencyContactName: string | null;
    emergencyContactPhone: string | null;
    hasPan?: boolean;
    panLast4?: string | null;
    hasUan?: boolean;
    hasEsicNumber?: boolean;
    hasBankDetails?: boolean;
    bankLast4?: string | null;
  };
  canEditEmploymentDetails?: boolean;
}) {
  const [fullName, setFullName] = useState('');
  const [primaryPhone, setPhone] = useState('');
  const [primaryEmail, setEmail] = useState('');
  const [dateOfBirth, setDob] = useState('');
  const [bloodGroup, setBloodGroup] = useState<BloodGroup | ''>('');
  const [emergencyContactName, setEmergencyName] = useState('');
  const [emergencyContactPhone, setEmergencyPhone] = useState('');

  const [hireEffectiveDate, setHireDate] = useState('');
  const [noticePeriodDays, setNoticePeriod] = useState('');
  const [engagementType, setEngagementType] = useState<EmploymentEngagementType | ''>('');
  const [panNumber, setPan] = useState('');
  const [uanNumber, setUan] = useState('');
  const [esicNumber, setEsic] = useState('');
  const [bankAccountNumber, setBankAccountNumber] = useState('');
  const [bankIfsc, setBankIfsc] = useState('');
  const [bankAccountName, setBankAccountName] = useState('');

  useEffect(() => {
    if (!open) return;
    setFullName(person.fullName ?? '');
    setPhone(person.primaryPhone ?? '');
    setEmail(person.primaryEmail ?? '');
    setDob(person.dateOfBirth ? person.dateOfBirth.slice(0, 10) : '');
    setBloodGroup('');
    setEmergencyName(employment?.emergencyContactName ?? '');
    setEmergencyPhone(employment?.emergencyContactPhone ?? '');
    setHireDate(employment?.hireEffectiveDate ? employment.hireEffectiveDate.slice(0, 10) : '');
    setNoticePeriod(employment ? String(employment.noticePeriodDays ?? '') : '');
    setEngagementType((employment?.engagementType as EmploymentEngagementType) ?? '');
    setPan('');
    setUan('');
    setEsic('');
    setBankAccountNumber('');
    setBankIfsc('');
    setBankAccountName('');
  }, [open, person, employment]);

  return (
    <CreateModal
      open={open}
      title="Edit their details"
      submitLabel="Save"
      onClose={onClose}
      invalidate={[['hr-employee', employmentId], ['hr-employees']]}
      onSubmit={() =>
        api.patch(`/hr/employees/${employmentId}`, {
          fullName,
          primaryPhone: primaryPhone || null,
          primaryEmail: primaryEmail || null,
          dateOfBirth: dateOfBirth || null,
          bloodGroup: orUndefined(bloodGroup),
          emergencyContactName: emergencyContactName || null,
          emergencyContactPhone: emergencyContactPhone || null,
          ...(canEditEmploymentDetails
            ? {
                hireEffectiveDate: orUndefined(hireEffectiveDate),
                noticePeriodDays: noticePeriodDays ? Number(noticePeriodDays) : undefined,
                engagementType: orUndefined(engagementType),
                panNumber: orUndefined(panNumber),
                uanNumber: orUndefined(uanNumber),
                esicNumber: orUndefined(esicNumber),
                bankAccountNumber: orUndefined(bankAccountNumber),
                bankIfsc: orUndefined(bankIfsc),
                bankAccountName: orUndefined(bankAccountName),
              }
            : {}),
        })
      }
    >
      <p className="section-title">Personal</p>
      <TextInput label="Name" required autoFocus value={fullName} onChange={setFullName} />
      <Row>
        <TextInput label="Phone" type="tel" value={primaryPhone} onChange={setPhone} hint="10-digit Indian mobile" />
        <TextInput label="Email" type="email" value={primaryEmail} onChange={setEmail} />
      </Row>
      <Row>
        <TextInput label="Date of birth" type="date" value={dateOfBirth} onChange={setDob} />
        <SelectInput
          label="Blood group"
          value={bloodGroup}
          onChange={setBloodGroup}
          options={BLOOD_GROUPS.map((g) => ({ value: g, label: g }))}
          placeholder="— leave as is —"
          hint={onFileHint(Boolean(person.hasBloodGroup))}
        />
      </Row>
      <Row>
        <TextInput label="Emergency contact name" value={emergencyContactName} onChange={setEmergencyName} />
        <TextInput
          label="Emergency contact phone"
          type="tel"
          value={emergencyContactPhone}
          onChange={setEmergencyPhone}
        />
      </Row>

      {canEditEmploymentDetails && employment && (
        <>
          <div className="divider" />
          <p className="section-title">Employment — HR only</p>
          <Row>
            <TextInput label="Hire date" type="date" value={hireEffectiveDate} onChange={setHireDate} />
            <TextInput label="Notice period (days)" type="number" value={noticePeriodDays} onChange={setNoticePeriod} />
          </Row>
          <SelectInput
            label="Engagement type"
            value={engagementType}
            onChange={setEngagementType}
            options={EMPLOYMENT_ENGAGEMENT_TYPES.map((t) => ({ value: t, label: titleCaseWord(t) }))}
          />
          <Row>
            <TextInput
              label="PAN"
              value={panNumber}
              onChange={setPan}
              hint={onFileHint(Boolean(employment.hasPan), employment.panLast4)}
            />
            <TextInput label="UAN" value={uanNumber} onChange={setUan} hint={onFileHint(Boolean(employment.hasUan))} />
          </Row>
          <TextInput
            label="ESIC number"
            value={esicNumber}
            onChange={setEsic}
            hint={onFileHint(Boolean(employment.hasEsicNumber))}
          />
          <Row>
            <TextInput
              label="Bank account number"
              value={bankAccountNumber}
              onChange={setBankAccountNumber}
              hint={onFileHint(Boolean(employment.hasBankDetails), employment.bankLast4)}
            />
            <TextInput label="Bank IFSC" value={bankIfsc} onChange={setBankIfsc} />
          </Row>
          <TextInput label="Bank account name" value={bankAccountName} onChange={setBankAccountName} />
        </>
      )}

      <p className="text-2xs text-ink-500">
        Confirmation, notice period status, separation, where they sit and what they are paid each move through their
        own action elsewhere on this page, not here.
      </p>
    </CreateModal>
  );
}

function titleCaseWord(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A pay change. Never a direct edit to what somebody earns — this opens the
 * same two-party proposal Finance has to sign off that the API has always
 * had (`POST /hr/compensation`), just reachable from the employee's own page
 * for the first time. A promotion has to name the assignment that promoted
 * them [Canon §14.5]; anything else does not.
 */
export function ProposeCompensation({
  open,
  onClose,
  employmentRelationshipId,
}: {
  open: boolean;
  onClose: () => void;
  employmentRelationshipId: string;
}) {
  const [revisionReason, setReason] = useState<CompensationRevisionReason | ''>('');
  const [amount, setAmount] = useState('');
  const [basicPay, setBasicPay] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [linkedAssignmentId, setLinkedAssignmentId] = useState('');

  useEffect(() => {
    if (!open) return;
    setReason('');
    setAmount('');
    setBasicPay('');
    setEffectiveFrom(today());
    setLinkedAssignmentId('');
  }, [open]);

  const isPromotion = revisionReason === PROMOTION_REVISION_REASON;

  return (
    <CreateModal
      open={open}
      title="Propose a pay change"
      submitLabel="Send for approval"
      onClose={onClose}
      invalidate={[
        ['hr-compensation', employmentRelationshipId],
        ['hr-employee', employmentRelationshipId],
      ]}
      onSubmit={() =>
        api.post('/hr/compensation', {
          employmentRelationshipId,
          revisionReason,
          amount: Number(amount),
          basicPay: basicPay ? Number(basicPay) : undefined,
          effectiveFrom,
          linkedAssignmentId: isPromotion ? linkedAssignmentId : undefined,
        })
      }
    >
      <SelectInput
        label="Reason"
        required
        value={revisionReason}
        onChange={setReason}
        options={COMPENSATION_REVISION_REASONS.map((r) => ({ value: r, label: titleCase(r.replace(/_/g, ' ')) }))}
        placeholder="Choose a reason"
      />
      <Row>
        <MoneyInput label="New monthly pay" required value={amount} onChange={setAmount} />
        <MoneyInput label="Of which basic" value={basicPay} onChange={setBasicPay} />
      </Row>
      <TextInput label="Effective from" type="date" required value={effectiveFrom} onChange={setEffectiveFrom} />
      {isPromotion && (
        <TextInput
          label="Linked assignment id"
          required
          value={linkedAssignmentId}
          onChange={setLinkedAssignmentId}
          hint="A promotion pay change has to name the seat move it goes with [Canon §14.5]."
        />
      )}
      <p className="text-2xs text-ink-500">
        This does not change anybody's pay by itself — it opens a proposal Finance has to approve, and never the person
        who proposed it or the person it is about.
      </p>
    </CreateModal>
  );
}

interface PositionOption {
  id: string;
  recordCode: string;
  status: string;
  job: { title: string };
  orgUnit: { name: string; division: string | null };
}

/** Opens a seat change: a new Assignment, Draft until whoever approves it moves it on
 * through the machine [Canon §14.3 R4]. Submitting here only proposes — the
 * employee's card keeps showing their current seat until the last ACTIVATE. */
export function NewAssignment({
  open,
  onClose,
  employmentRelationshipId,
}: {
  open: boolean;
  onClose: () => void;
  employmentRelationshipId: string;
}) {
  const [positionId, setPositionId] = useState('');
  const [reasonCode, setReasonCode] = useState<AssignmentReasonCode | ''>('');
  const [effectiveFrom, setEffectiveFrom] = useState(today());

  const positions = useQuery({
    queryKey: ['positions-for-assignment'],
    queryFn: () => api.get<PositionOption[]>('/hr/positions'),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setPositionId('');
    setReasonCode('');
    setEffectiveFrom(today());
  }, [open]);

  return (
    <CreateModal
      open={open}
      title="Change position"
      submitLabel="Propose"
      onClose={onClose}
      invalidate={[['hr-employee', employmentRelationshipId]]}
      onSubmit={() =>
        api.post('/hr/assignments', {
          employmentRelationshipId,
          positionId,
          reasonCode,
          effectiveFrom,
        })
      }
    >
      <SelectInput
        label="New position"
        required
        value={positionId}
        onChange={setPositionId}
        options={(positions.data ?? []).map((p) => ({
          value: p.id,
          label: `${p.job.title} — ${p.orgUnit.name} (${p.recordCode})`,
        }))}
        placeholder={positions.isLoading ? 'Loading positions…' : 'Choose a position'}
      />
      <SelectInput
        label="Reason"
        required
        value={reasonCode}
        onChange={setReasonCode}
        options={ASSIGNMENT_REASON_CODES.map((r) => ({ value: r, label: r }))}
        placeholder="Choose a reason"
      />
      <TextInput label="Effective from" type="date" required value={effectiveFrom} onChange={setEffectiveFrom} />
      <p className="text-2xs text-ink-500">
        This opens a proposal, Draft until it is submitted, approved, scheduled and activated — the same approval the
        seat's own history already requires. Nothing about where they sit changes until it is activated.
      </p>
    </CreateModal>
  );
}

export function NewLeaveRequest({
  open,
  onClose,
  employmentRelationshipId,
}: {
  open: boolean;
  onClose: () => void;
  employmentRelationshipId?: string;
}) {
  const types = useList<Named & { code: string }>('leave-types', '/hr/leave-types', open);
  const employments = useList<{ id: string; personName?: string; recordCode: string }>(
    'employments',
    '/hr/employees',
    open && !employmentRelationshipId,
  );

  const [employmentId, setEmploymentId] = useState(employmentRelationshipId ?? '');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStart] = useState(today());
  const [endDate, setEnd] = useState(today());
  const [reason, setReason] = useState('');

  const days =
    Math.max(1, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000) + 1) || 1;

  return (
    <CreateModal
      open={open}
      title="Request leave"
      submitLabel="Request it"
      onClose={onClose}
      invalidate={[['leave-requests'], ['leave-balances']]}
      onSubmit={() =>
        api.post('/hr/leave-requests', {
          employmentRelationshipId: employmentRelationshipId ?? employmentId,
          leaveTypeId,
          startDate,
          endDate,
          days,
          reason: reason || null,
        })
      }
    >
      {!employmentRelationshipId && (
        <SelectInput
          label="Who"
          required
          value={employmentId}
          onChange={setEmploymentId}
          placeholder="Choose an employee"
          options={employments.rows.map((e) => ({ value: e.id, label: e.personName ?? e.recordCode }))}
        />
      )}
      <SelectInput
        label="Kind of leave"
        required
        value={leaveTypeId}
        onChange={setLeaveTypeId}
        placeholder="Choose"
        options={types.rows.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))}
      />
      <Row>
        <TextInput label="From" type="date" required value={startDate} onChange={setStart} />
        <TextInput label="To" type="date" required value={endDate} onChange={setEnd} />
      </Row>
      <TextArea label="Reason" value={reason} onChange={setReason} rows={2} />
      <p className="text-2xs text-ink-500">
        {days} {days === 1 ? 'day' : 'days'}. Approval places a hold on the balance rather than deducting it; the
        deduction happens when the leave is actually taken.
      </p>
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Hiring
// ---------------------------------------------------------------------------

/**
 * Posting a vacancy.
 *
 * A requisition needs a position, a position needs a job and an org unit, and a
 * job needs a title, a family and a level. Asking somebody to create four
 * records in the right order before they can advertise a job is why this screen
 * had no create button at all — so the form does the chain itself, reusing what
 * already exists and creating only what does not.
 *
 * The four records are still four records. They are what makes "which seats are
 * open in Software" a question with an answer; what changes is that nobody has
 * to know that to hire somebody.
 */
export function NewRequisition({ open, onClose }: { open: boolean; onClose: () => void }) {
  const orgUnits = useList<Named>('org-units', '/hr/org-units', open);
  const jobs = useList<{ id: string; title: string }>('jobs', '/hr/jobs', open);

  const [jobId, setJobId] = useState('');
  const [newJobTitle, setNewJobTitle] = useState('');
  const [orgUnitId, setOrgUnitId] = useState('');
  const [newUnitName, setNewUnitName] = useState('');
  const [division, setDivision] = useState('shared');
  const [location, setLocation] = useState('Madurai');
  const [targetStartDate, setStart] = useState('');

  const creatingJob = jobId === '__new';
  const creatingUnit = orgUnitId === '__new';

  return (
    <CreateModal
      open={open}
      title="Post a vacancy"
      submitLabel="Post it"
      onClose={onClose}
      invalidate={[['requisitions'], ['positions'], ['jobs'], ['org-units']]}
      onSubmit={async () => {
        const unit = creatingUnit
          ? await api.post<{ id: string }>('/hr/org-units', {
              name: newUnitName,
              unitType: 'department',
              division,
            })
          : { id: orgUnitId };

        const job = creatingJob
          ? await api.post<{ id: string }>('/hr/jobs', {
              title: newJobTitle,
              // A staff list gives no family or level, and a job with neither
              // makes the establishment view meaningless — so they are read out
              // of the title and can be corrected on the job itself.
              jobFamily: familyOf(newJobTitle),
              jobLevel: levelOf(newJobTitle),
            })
          : { id: jobId };

        const position = await api.post<{ id: string }>('/hr/positions', {
          orgUnitId: unit.id,
          jobId: job.id,
          location,
        });

        return api.post('/hr/requisitions', {
          positionId: position.id,
          targetStartDate: targetStartDate || null,
        });
      }}
    >
      <SelectInput
        label="The job"
        required
        value={jobId}
        onChange={setJobId}
        placeholder="Choose a job, or add one"
        options={[
          ...jobs.rows.map((j) => ({ value: j.id, label: j.title })),
          { value: '__new', label: '+ A job we have not hired for before' },
        ]}
      />
      {creatingJob && (
        <TextInput
          label="Job title"
          required
          value={newJobTitle}
          onChange={setNewJobTitle}
          placeholder="Senior Developer"
        />
      )}

      <SelectInput
        label="Which team"
        required
        value={orgUnitId}
        onChange={setOrgUnitId}
        placeholder="Choose a team, or add one"
        options={[
          ...orgUnits.rows.map((u) => ({ value: u.id, label: u.name })),
          { value: '__new', label: '+ A new team' },
        ]}
      />
      {creatingUnit && (
        <Row>
          <TextInput
            label="Team name"
            required
            value={newUnitName}
            onChange={setNewUnitName}
            placeholder="Cybersecurity"
          />
          <SelectInput label="Division" value={division} onChange={setDivision} options={DIVISIONS} />
        </Row>
      )}

      <Row>
        <TextInput label="Where" value={location} onChange={setLocation} />
        <TextInput label="Wanted by" type="date" value={targetStartDate} onChange={setStart} />
      </Row>
      <p className="text-2xs text-ink-500">
        This creates the seat as well as the vacancy, so the establishment shows one more chair in that team whether or
        not anybody is sitting in it yet.
      </p>
    </CreateModal>
  );
}

const familyOf = (title: string): string => {
  const t = title.toLowerCase();
  if (/develop|engineer|software|cyber|data/.test(t)) return 'engineering';
  if (/train|instructor|academic|teach/.test(t)) return 'delivery';
  if (/market|design|creative|content/.test(t)) return 'marketing';
  if (/sales|business development|counsel/.test(t)) return 'commercial';
  if (/hr|operation|admin|front office|keeping|account|finance/.test(t)) return 'operations';
  return 'general';
};

const levelOf = (title: string): string => {
  const t = title.toLowerCase();
  if (/head|director|chief|manager|lead/.test(t)) return 'lead';
  if (/senior|sr\.?/.test(t)) return 'senior';
  if (/trainee|intern|junior|jr\.?|associate/.test(t)) return 'entry';
  return 'mid';
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Putting a decision on the record before it is made.
 *
 * The point of the entity is that a decision is a thing with a question, an
 * authority basis and a point of no return — not a status somebody sets after
 * the fact. Recording it while it is still open is what makes the review
 * afterwards worth anything.
 */
export function NewDecision({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [subjectLabel, setSubjectLabel] = useState('');
  const [authorityBasis, setBasis] = useState('');
  const [pointOfNoReturn, setPoint] = useState('');
  const [noActionConsequence, setConsequence] = useState('');

  return (
    <CreateModal
      open={open}
      title="Put a decision on the record"
      submitLabel="Record it"
      onClose={onClose}
      invalidate={[['decisions']]}
      onSubmit={() =>
        api.post('/command/decisions', {
          question,
          subjectType: 'free_form',
          subjectLabel: subjectLabel || question.slice(0, 80),
          authorityBasis: authorityBasis || 'chairman',
          pointOfNoReturn: pointOfNoReturn || null,
          noActionConsequence: noActionConsequence ? { summary: noActionConsequence } : null,
        })
      }
    >
      <TextArea
        label="The question"
        required
        rows={2}
        value={question}
        onChange={setQuestion}
        placeholder="Do we take the Chennai office lease?"
      />
      <Row>
        <TextInput label="About what" value={subjectLabel} onChange={setSubjectLabel} placeholder="Chennai office" />
        <TextInput
          label="Whose call"
          value={authorityBasis}
          onChange={setBasis}
          placeholder="chairman"
          hint="the role that decides"
        />
      </Row>
      <TextInput
        label="Point of no return"
        type="date"
        value={pointOfNoReturn}
        onChange={setPoint}
        hint="after this, deferring is not an option"
      />
      <TextArea
        label="What happens if nobody decides"
        value={noActionConsequence}
        onChange={setConsequence}
        rows={2}
        hint="doing nothing is a choice, so it is written down as one"
      />
    </CreateModal>
  );
}

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

/**
 * Enrolling a student.
 *
 * There was no way to do this at all: the platform could change a student's
 * status and mark their attendance, but nothing could create one, so every
 * learner had to have arrived through a seed.
 *
 * The college is asked for on the way in rather than added later. Recruiting
 * out of a partner institution is the reason colleges are tracked separately
 * from client companies, and a student whose college is unrecorded makes that
 * relationship unmeasurable — the field exists to make "how many did this
 * college send us, and how did they do" answerable.
 */
/**
 * Enrolling somebody.
 *
 * "Somebody new" and "somebody already on file" are asked as two different
 * things, because they are. The endpoint has always accepted a person id and
 * the form never offered one, so enrolling a contact who was already in the
 * system typed their name in again and created a second human — in a product
 * whose Contacts page promises one record per person, kept for good.
 *
 * A student is not a separate kind of record from a contact. Enrolling is what
 * gives an existing person a student affiliation; that is the distinction, and
 * it is a relationship rather than a table.
 */
export function NewEnrollment({ open, onClose }: { open: boolean; onClose: () => void }) {
  const cohorts = useList<{ id: string; name: string; courseName?: string }>('cohorts', '/education/cohorts', open);
  const colleges = useList<Named>('institutions', '/crm/institutions?pageSize=200', open);
  const people = useList<{ id: string; fullName: string; recordCode: string; primaryPhone?: string | null }>(
    'people-picker',
    '/crm/people?pageSize=200',
    open,
  );

  const [who, setWho] = useState<'new' | 'existing'>('new');
  const [cohortId, setCohortId] = useState('');
  const [personId, setPersonId] = useState('');
  const [fullName, setFullName] = useState('');
  const [primaryPhone, setPhone] = useState('');
  const [primaryEmail, setEmail] = useState('');
  const [institutionId, setInstitutionId] = useState('');
  const [learnerDob, setLearnerDob] = useState('');
  // Unchecked by default: an unknown age is held to the minor rule until
  // somebody says, on the record, that the learner is an adult. FX-64.
  const [adultAttested, setAdultAttested] = useState(false);
  const [guardianName, setGuardianName] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');

  const dobDate = learnerDob ? new Date(learnerDob) : null;
  const dobKnown = !!dobDate && !Number.isNaN(dobDate.getTime());
  // Mirrors the server's rule: a date of birth decides when there is one,
  // otherwise the attestation does. The server has the final word.
  const adultByRecord = dobDate && dobKnown ? (ageInYears(dobDate) ?? 0) >= 18 : adultAttested;
  const guardianRequired = !adultByRecord;

  return (
    <CreateModal
      open={open}
      title="Enrol a student"
      submitLabel="Enrol them"
      onClose={onClose}
      invalidate={[['enrollments'], ['cohorts'], ['people']]}
      onSubmit={() =>
        api.post('/education/enrollments', {
          cohortId,
          ...(who === 'existing'
            ? { personId }
            : {
                fullName,
                primaryPhone: primaryPhone || null,
                primaryEmail: primaryEmail || null,
              }),
          institutionId: institutionId || null,
          dateOfBirth: learnerDob || null,
          adultAttested: !learnerDob && adultAttested,
          guardianName: guardianName || null,
          guardianPhone: guardianPhone || null,
        })
      }
    >
      <div className="flex gap-2">
        {(
          [
            ['new', 'Somebody new'],
            ['existing', 'Somebody already on file'],
          ] as Array<['new' | 'existing', string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setWho(value)}
            className={`chip transition-colors ${
              who === value ? 'border-accent/60 text-accent-soft' : 'border-ink-800 text-ink-500 hover:border-ink-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {who === 'existing' ? (
        <SelectInput
          label="Which person"
          required
          value={personId}
          onChange={setPersonId}
          placeholder={people.rows.length ? 'Search the contacts already on file' : 'Nobody on file yet'}
          options={people.rows.map((pp) => ({
            value: pp.id,
            label: pp.primaryPhone ? `${pp.fullName} — ${pp.primaryPhone}` : pp.fullName,
          }))}
          hint="they keep their record and gain a student role on it"
        />
      ) : (
        <>
          <TextInput label="Name" required autoFocus value={fullName} onChange={setFullName} />
          <Row>
            <TextInput label="Phone" type="tel" value={primaryPhone} onChange={setPhone} />
            <TextInput label="Email" type="email" value={primaryEmail} onChange={setEmail} />
          </Row>
          <p className="text-2xs text-ink-500">A phone or email is matched against people already on file.</p>
        </>
      )}
      <SelectInput
        label="Batch"
        required
        value={cohortId}
        onChange={setCohortId}
        placeholder={cohorts.rows.length ? 'Which batch' : 'No batches yet — create one first'}
        options={cohorts.rows.map((c) => ({
          value: c.id,
          label: c.courseName ? `${c.name} — ${c.courseName}` : c.name,
        }))}
      />
      <SelectInput
        label="Which college are they from"
        hint="leave blank for a direct enrolment"
        value={institutionId}
        onChange={setInstitutionId}
        placeholder={colleges.rows.length ? 'Not from a college' : 'No colleges on file yet'}
        options={colleges.rows.map((c) => ({ value: c.id, label: c.name }))}
      />

      <TextInput label="Date of birth" type="date" value={learnerDob} onChange={setLearnerDob} />
      {!learnerDob && (
        <>
          <label className="flex items-center gap-2 text-sm text-ink-200">
            <input type="checkbox" checked={adultAttested} onChange={(e) => setAdultAttested(e.target.checked)} />I
            attest they are 18 or over
          </label>
          <p className="text-2xs text-ink-500">
            With no date of birth, a learner is treated as under 18 until you attest otherwise. Your attestation is
            recorded against your name.
          </p>
        </>
      )}
      {guardianRequired && (
        <>
          <Row>
            <TextInput label="Guardian name" required value={guardianName} onChange={setGuardianName} />
            <TextInput label="Guardian phone" required type="tel" value={guardianPhone} onChange={setGuardianPhone} />
          </Row>
          <p className="text-2xs text-ink-500">
            A guardian is required for a learner under 18. Guardian contact is protected. Every look at it is recorded.
          </p>
        </>
      )}
    </CreateModal>
  );
}

export function NewCohort({ open, onClose }: { open: boolean; onClose: () => void }) {
  const courses = useList<{ id: string; name: string; code: string }>('courses', '/education/courses', open);
  const colleges = useList<Named>('institutions', '/crm/institutions?pageSize=200', open);

  const [courseId, setCourseId] = useState('');
  const [name, setName] = useState('');
  const [startDate, setStart] = useState(today());
  const [endDate, setEnd] = useState('');
  const [institutionId, setInstitutionId] = useState('');
  const [capacity, setCapacity] = useState('30');

  return (
    <CreateModal
      open={open}
      title="Start a batch"
      submitLabel="Create it"
      onClose={onClose}
      invalidate={[['cohorts']]}
      onSubmit={() =>
        api.post('/education/cohorts', {
          courseId,
          name,
          startDate,
          endDate: endDate || null,
          institutionId: institutionId || null,
          capacity: Number(capacity || 30),
        })
      }
    >
      <SelectInput
        label="Course"
        required
        value={courseId}
        onChange={setCourseId}
        placeholder={courses.rows.length ? 'Which course' : 'No courses yet — add one first'}
        options={courses.rows.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))}
      />
      <TextInput label="Batch name" required value={name} onChange={setName} placeholder="FSD — Sept 2026, Madurai" />
      <Row>
        <TextInput label="Starts" type="date" required value={startDate} onChange={setStart} />
        <TextInput label="Ends" type="date" value={endDate} onChange={setEnd} />
      </Row>
      <Row>
        <SelectInput
          label="Where it runs"
          hint="a college hosting it, if any"
          value={institutionId}
          onChange={setInstitutionId}
          placeholder="Our own premises"
          options={colleges.rows.map((c) => ({ value: c.id, label: c.name }))}
        />
        <TextInput label="Seats" type="number" value={capacity} onChange={setCapacity} />
      </Row>
      <p className="text-2xs text-ink-500">Where the batch runs and where the student came from are different.</p>
    </CreateModal>
  );
}

export function NewCourse({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [durationWeeks, setWeeks] = useState('');

  return (
    <CreateModal
      open={open}
      title="Add a course"
      submitLabel="Add it"
      onClose={onClose}
      invalidate={[['courses']]}
      onSubmit={() =>
        api.post('/education/courses', {
          name,
          code:
            code ||
            name
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, '-')
              .slice(0, 16),
          description: description || null,
          durationWeeks: durationWeeks ? Number(durationWeeks) : null,
        })
      }
    >
      <Row>
        <TextInput
          label="Name"
          required
          autoFocus
          value={name}
          onChange={setName}
          placeholder="Full Stack Development"
        />
        <TextInput label="Code" hint="made from the name if blank" value={code} onChange={setCode} placeholder="FSD" />
      </Row>
      <TextArea label="What it covers" value={description} onChange={setDescription} rows={2} />
      <TextInput label="Length (weeks)" type="number" value={durationWeeks} onChange={setWeeks} />
      <p className="text-2xs text-ink-500">
        A course is the syllabus. A batch is one run of it, with dates and people.
      </p>
    </CreateModal>
  );
}
