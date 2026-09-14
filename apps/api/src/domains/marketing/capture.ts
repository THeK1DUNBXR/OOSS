/**
 * Forms & lead capture (MKT-CAP-001 through MKT-CAP-003, MKT-CAP-008).
 *
 * The public surface here (`submitPublicForm`, `resolveAndClick`,
 * `receiveWebhook`) runs with NO authenticated principal — a public form
 * visitor and an inbound webhook carry no session. Each resolves its own
 * tenant first (from the form's `publicToken`, the short link's `slug`, or a
 * webhook's `X-Kai-Tenant` header / `tenant` query param) using the raw,
 * unscoped client — the same narrow exception `lib/auth.ts` login() takes —
 * and then does everything else inside `asSystem(tenantId, ...)`, so every
 * write after that point goes through the ordinary tenant-scoped `prisma`
 * and the ordinary SYSTEM_PRINCIPAL five-axis short-circuit. No route ever
 * trusts a client-supplied tenant id for anything but that first lookup.
 *
 * Marketing never writes `Lead.ownerPartyId` and never routes a lead — every
 * lead this file creates goes through `domains/leads.ts#createLead`, which is
 * the only thing that touches routing.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { CHANNEL_KEYS, EVENTS, VERTICALS, type ChannelKey, type FormSubmissionStatus, type Vertical } from '@kaizen/shared';
import { prisma, unscopedPrisma, Prisma } from '../../platform/db.js';
import { asSystem, currentAuth } from '../../platform/context.js';
import { emit } from '../../platform/eventBus.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { ApiError } from '../../platform/errors.js';
import { assertCan } from '../../platform/permissions.js';
import { raiseException } from '../../platform/exceptions.js';
import { findOrCreatePerson, type PersonInput } from '../identity.js';
import { createLead } from '../leads.js';
import { recordTouchpoint } from './attribution.js';
import { getAdapter } from './adapters/registry.js';
import { onFormSubmitted } from './journeys.js';
import { applyDeliveryEvents } from './messaging.js';

function internalCode(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export const FORM_FIELD_TYPES = ['text', 'email', 'phone', 'select', 'textarea', 'checkbox', 'hidden'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export interface FormFieldDef {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  options?: string[];
}

export interface FormInput {
  name: string;
  slug?: string;
  fields: FormFieldDef[];
  vertical: string;
  defaultCampaignId?: string | null;
  thankYouMessage?: string;
}

export type { FormView } from '@kaizen/shared';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) || `form-${Date.now()}`;
}

function validateFields(fields: unknown): FormFieldDef[] {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw ApiError.badRequest('A form requires at least one field.');
  }
  return fields.map((raw, i) => {
    const f = raw as Partial<FormFieldDef>;
    if (!f || typeof f.key !== 'string' || !f.key) throw ApiError.badRequest(`fields[${i}].key is required.`);
    if (typeof f.label !== 'string' || !f.label) throw ApiError.badRequest(`fields[${i}].label is required.`);
    if (!FORM_FIELD_TYPES.includes(f.type as FormFieldType)) {
      throw ApiError.badRequest(`fields[${i}].type must be one of ${FORM_FIELD_TYPES.join(', ')}.`);
    }
    if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
      throw ApiError.badRequest(`fields[${i}] is type 'select' and requires a non-empty options[].`);
    }
    return { key: f.key, label: f.label, type: f.type as FormFieldType, required: Boolean(f.required), options: f.options };
  });
}

function newPublicToken(): string {
  return randomBytes(32).toString('hex');
}

export async function createForm(input: FormInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'create' });

  const fields = validateFields(input.fields);
  const slug = input.slug ? slugify(input.slug) : slugify(input.name);
  const recordCode = await nextRecordCode('FRM');

  try {
    const form = await prisma.marketingForm.create({
      data: {
        tenantId: auth.tenantId,
        recordCode,
        name: input.name,
        slug,
        fields: fields as never,
        vertical: input.vertical,
        defaultCampaignId: input.defaultCampaignId ?? null,
        thankYouMessage: input.thankYouMessage ?? 'Thanks — we will be in touch shortly.',
        active: false,
        publicToken: newPublicToken(),
        createdById: auth.partyId,
      },
    });

    await emit({
      name: EVENTS.MKT_FORM_CREATED,
      subject: { entityType: 'marketing_form', entityId: form.id, recordCode: form.recordCode },
      newState: { slug: form.slug, active: form.active },
    });

    return form;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw ApiError.conflict(`A form with slug '${slug}' already exists.`);
    }
    throw err;
  }
}

export interface FormListFilters {
  q?: string;
  active?: boolean;
}

export async function listForms(filters: FormListFilters = {}) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'view' });

  const where = {
    tenantId: auth.tenantId,
    deletedAt: null,
    ...(filters.active !== undefined ? { active: filters.active } : {}),
    ...(filters.q ? { name: { contains: filters.q, mode: 'insensitive' as const } } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.marketingForm.findMany({ where, orderBy: { createdAt: 'desc' } }),
    prisma.marketingForm.count({ where }),
  ]);
  return { items, total };
}

export async function loadForm(id: string) {
  await assertCan({ resource: 'marketing_forms', verb: 'view' });
  const auth = currentAuth();
  const form = await prisma.marketingForm.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!form) throw ApiError.notFound('Form');
  const convertedCount = await prisma.marketingFormSubmission.count({ where: { formId: id, status: 'converted' } });
  const conversionRate = form.submissionCount > 0 ? convertedCount / form.submissionCount : null;
  return { ...form, conversionRate };
}

export async function updateForm(id: string, patch: Partial<FormInput>) {
  await assertCan({ resource: 'marketing_forms', verb: 'edit' });
  const auth = currentAuth();
  const existing = await prisma.marketingForm.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!existing) throw ApiError.notFound('Form');

  const slug = patch.slug ? slugify(patch.slug) : undefined;

  try {
    return await prisma.marketingForm.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(patch.fields !== undefined ? { fields: validateFields(patch.fields) as never } : {}),
        ...(patch.vertical !== undefined ? { vertical: patch.vertical } : {}),
        ...(patch.defaultCampaignId !== undefined ? { defaultCampaignId: patch.defaultCampaignId } : {}),
        ...(patch.thankYouMessage !== undefined ? { thankYouMessage: patch.thankYouMessage } : {}),
        updatedById: auth.partyId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw ApiError.conflict(`A form with slug '${slug}' already exists.`);
    }
    throw err;
  }
}

export async function publishForm(id: string) {
  await assertCan({ resource: 'marketing_forms', verb: 'edit' });
  const auth = currentAuth();
  const form = await prisma.marketingForm.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!form) throw ApiError.notFound('Form');
  const updated = await prisma.marketingForm.update({ where: { id }, data: { active: true } });
  await emit({
    name: EVENTS.MKT_FORM_PUBLISHED,
    subject: { entityType: 'marketing_form', entityId: id, recordCode: form.recordCode },
    newState: { active: true },
  });
  return updated;
}

export async function unpublishForm(id: string) {
  await assertCan({ resource: 'marketing_forms', verb: 'edit' });
  const auth = currentAuth();
  const form = await prisma.marketingForm.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!form) throw ApiError.notFound('Form');
  return prisma.marketingForm.update({ where: { id }, data: { active: false } });
}

/** Kept for `domains/marketing/index.ts`'s barrel export — archiving a form is deactivating it; there is no separate archived state in the schema. */
export const archiveForm = unpublishForm;

export async function rotateToken(id: string) {
  await assertCan({ resource: 'marketing_forms', verb: 'edit' });
  const auth = currentAuth();
  const form = await prisma.marketingForm.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!form) throw ApiError.notFound('Form');
  return prisma.marketingForm.update({ where: { id }, data: { publicToken: newPublicToken() } });
}

export async function formEmbedInfo(id: string): Promise<{ publicUrl: string; embedSnippet: string }> {
  await assertCan({ resource: 'marketing_forms', verb: 'view' });
  const auth = currentAuth();
  const form = await prisma.marketingForm.findFirst({ where: { id, tenantId: auth.tenantId, deletedAt: null } });
  if (!form) throw ApiError.notFound('Form');

  const publicUrl = `/api/marketing/public/forms/${form.publicToken}/submit`;
  const fields = form.fields as unknown as FormFieldDef[];
  const inputsHtml = fields
    .map((f) => {
      if (f.type === 'select') {
        const opts = (f.options ?? []).map((o) => `<option value="${o}">${o}</option>`).join('');
        return `<label>${f.label}<select name="${f.key}" ${f.required ? 'required' : ''}>${opts}</select></label>`;
      }
      if (f.type === 'textarea') {
        return `<label>${f.label}<textarea name="${f.key}" ${f.required ? 'required' : ''}></textarea></label>`;
      }
      if (f.type === 'checkbox') {
        return `<label><input type="checkbox" name="${f.key}" ${f.required ? 'required' : ''}/> ${f.label}</label>`;
      }
      const htmlType = f.type === 'hidden' ? 'hidden' : f.type;
      return `<label>${f.label}<input type="${htmlType}" name="${f.key}" ${f.required ? 'required' : ''}/></label>`;
    })
    .join('\n  ');

  const embedSnippet = `<form method="POST" action="${publicUrl}">
  ${inputsHtml}
  <input type="text" name="website" style="display:none" tabindex="-1" autocomplete="off"/>
  <button type="submit">Submit</button>
</form>`;

  return { publicUrl, embedSnippet };
}

// ---------------------------------------------------------------------------
// Public submission — no auth, tenant resolved from the token
// ---------------------------------------------------------------------------

interface RateLimitState {
  timestamps: number[];
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimitByIp = new Map<string, RateLimitState>();

function checkRateLimit(ip: string): void {
  const now = Date.now();
  const state = rateLimitByIp.get(ip) ?? { timestamps: [] };
  state.timestamps = state.timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (state.timestamps.length >= RATE_LIMIT_MAX) {
    rateLimitByIp.set(ip, state);
    throw new ApiError(429, 'RATE_LIMITED', 'Too many submissions from this address. Try again in a minute.');
  }
  state.timestamps.push(now);
  rateLimitByIp.set(ip, state);
}

/** Test-only: clears the in-memory rate-limit table between test cases. */
export function resetRateLimitForTests(): void {
  rateLimitByIp.clear();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

const DUPLICATE_WINDOW_MS = 10 * 60_000;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Tolerant of common aliases: fullName/name/full_name, email, phone/mobile. */
function personInputFromPayload(payload: Record<string, unknown>): PersonInput {
  const fullName = str(payload.fullName) ?? str(payload.name) ?? str(payload.full_name) ?? str(payload.email) ?? str(payload.phone) ?? 'Unknown';
  return {
    fullName,
    primaryEmail: str(payload.email) ?? str(payload.primaryEmail),
    primaryPhone: str(payload.phone) ?? str(payload.mobile) ?? str(payload.primaryPhone),
    source: 'form',
  };
}

export interface SubmitMeta {
  ip?: string;
  userAgent?: string;
  utm?: Record<string, unknown>;
}

/**
 * MKT-CAP-001: a public form submission is accepted only against an active
 * publicToken. Honeypot and duplicate detection never reveal themselves to
 * the caller — both return the same `{ok:true}` shape a genuine submission
 * would.
 */
export async function submitPublicForm(
  publicToken: string,
  payload: Record<string, unknown>,
  meta: SubmitMeta = {},
): Promise<{ ok: true; message: string }> {
  checkRateLimit(meta.ip ?? 'unknown');

  const form = await unscopedPrisma.marketingForm.findFirst({ where: { publicToken } });
  if (!form || !form.active || form.deletedAt) throw ApiError.notFound('Form');

  const thankYouMessage = form.thankYouMessage ?? 'Thanks — we will be in touch shortly.';

  return asSystem(form.tenantId, async () => {
    const utm = (meta.utm ?? {}) as Record<string, unknown>;

    // Honeypot: a bot filling in the hidden `website` field is told nothing —
    // it is stored as spam and answered with the ordinary success message.
    const honeypot = str(payload.website);
    if (honeypot) {
      await prisma.marketingFormSubmission.create({
        data: {
          tenantId: form.tenantId,
          recordCode: internalCode('SUB'),
          formId: form.id,
          payload: payload as never,
          utm: utm as never,
          status: 'spam' satisfies FormSubmissionStatus,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
      });
      return { ok: true, message: thankYouMessage };
    }

    const payloadHash = stableStringify(payload);
    const recent = await prisma.marketingFormSubmission.findMany({
      where: { formId: form.id, receivedAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) } },
      orderBy: { receivedAt: 'desc' },
      take: 50,
    });
    const isDuplicate = recent.some((r) => stableStringify(r.payload) === payloadHash);

    if (isDuplicate) {
      await prisma.marketingFormSubmission.create({
        data: {
          tenantId: form.tenantId,
          recordCode: internalCode('SUB'),
          formId: form.id,
          payload: payload as never,
          utm: utm as never,
          status: 'duplicate' satisfies FormSubmissionStatus,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent ?? null,
        },
      });
      return { ok: true, message: thankYouMessage };
    }

    const campaignId = await resolveCampaignId(utm, form.defaultCampaignId);

    const submission = await prisma.marketingFormSubmission.create({
      data: {
        tenantId: form.tenantId,
        recordCode: internalCode('SUB'),
        formId: form.id,
        payload: payload as never,
        utm: utm as never,
        status: 'received',
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    await prisma.marketingForm.update({ where: { id: form.id }, data: { submissionCount: { increment: 1 } } });

    await recordTouchpoint({
      campaignId,
      channelKey: 'website',
      touchKind: 'form',
      utm,
    });

    await emit({
      name: EVENTS.MKT_FORM_SUBMISSION_RECEIVED,
      subject: { entityType: 'marketing_form_submission', entityId: submission.id, recordCode: submission.recordCode },
      related: [{ relation: 'form', entityType: 'marketing_form', entityId: form.id }],
      newState: { status: 'received' },
    });

    // The schema carries no per-form autoConvert flag/column, so every
    // received submission auto-converts.
    await convertSubmission(submission.id, { campaignId, channelKey: 'website', utm });

    return { ok: true, message: thankYouMessage };
  });
}

async function resolveCampaignId(utm: Record<string, unknown>, defaultCampaignId: string | null): Promise<string | null> {
  const utmCampaignSlug = str(utm.campaign) ?? str(utm.utm_campaign);
  if (utmCampaignSlug) {
    const campaign = await prisma.marketingCampaign.findFirst({ where: { utmCampaign: utmCampaignSlug } });
    if (campaign) return campaign.id;
  }
  return defaultCampaignId;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export interface ConvertContext {
  campaignId?: string | null;
  channelKey?: string | null;
  utm?: Record<string, unknown>;
}

/**
 * MKT-CAP-002: converts a submission via `findOrCreatePerson` (never a
 * duplicate Person) and `createLead` (never a direct Lead write bypassing
 * CRM's own scoring/routing). A MERGE_CANDIDATE (ambiguous identity match)
 * marks the submission `duplicate` with the reason recorded on the row's
 * payload note, rather than surfacing a 409 to whatever called this.
 */
export async function convertSubmission(submissionId: string, ctx: ConvertContext = {}) {
  const auth = currentAuth();
  const submission = await prisma.marketingFormSubmission.findFirst({ where: { id: submissionId, tenantId: auth.tenantId } });
  if (!submission) throw ApiError.notFound('Submission');
  if (submission.status !== 'received') return submission;

  const form = await prisma.marketingForm.findFirst({ where: { id: submission.formId } });
  if (!form) throw ApiError.notFound('Form');

  const personInput = personInputFromPayload(submission.payload as Record<string, unknown>);

  let personId: string;
  try {
    const resolved = await findOrCreatePerson(personInput);
    personId = resolved.person.id;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'DUPLICATE') {
      return prisma.marketingFormSubmission.update({ where: { id: submissionId }, data: { status: 'duplicate' } });
    }
    throw err;
  }

  const vertical = (VERTICALS as readonly string[]).includes(form.vertical ?? '') ? (form.vertical as Vertical) : 'other';

  const lead = await createLead({
    title: `Web enquiry — ${form.name}`,
    personId,
    vertical,
    source: 'form',
    sourceDetail: form.slug,
  });

  // createLead's LeadInput carries no campaignId/channelKey/utm — those are
  // marketing-specific columns Lead gained for this module, written back here.
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      campaignId: ctx.campaignId ?? null,
      channelKey: (ctx.channelKey ?? 'website') as never,
      utm: (ctx.utm ?? submission.utm ?? {}) as never,
    },
  });

  const updated = await prisma.marketingFormSubmission.update({
    where: { id: submissionId },
    data: { status: 'converted', personId, leadId: lead.id },
  });

  await emit({
    name: EVENTS.MKT_FORM_SUBMISSION_CONVERTED,
    subject: { entityType: 'marketing_form_submission', entityId: submissionId, recordCode: submission.recordCode },
    related: [
      { relation: 'person', entityType: 'person', entityId: personId },
      { relation: 'lead', entityType: 'lead', entityId: lead.id },
    ],
    newState: { status: 'converted' },
  });

  await onFormSubmitted(personId);

  return updated;
}

export async function rejectSubmission(submissionId: string, reason: string) {
  await assertCan({ resource: 'marketing_forms', verb: 'edit' });
  const auth = currentAuth();
  const submission = await prisma.marketingFormSubmission.findFirst({ where: { id: submissionId, tenantId: auth.tenantId } });
  if (!submission) throw ApiError.notFound('Submission');
  return prisma.marketingFormSubmission.update({ where: { id: submissionId }, data: { status: 'rejected' } });
}

export async function markSpamSubmission(submissionId: string) {
  await assertCan({ resource: 'marketing_forms', verb: 'edit' });
  const auth = currentAuth();
  const submission = await prisma.marketingFormSubmission.findFirst({ where: { id: submissionId, tenantId: auth.tenantId } });
  if (!submission) throw ApiError.notFound('Submission');
  return prisma.marketingFormSubmission.update({ where: { id: submissionId }, data: { status: 'spam' } });
}

export async function listFormSubmissions(formId: string, filters: { status?: string } = {}) {
  await assertCan({ resource: 'marketing_forms', verb: 'view' });
  const auth = currentAuth();
  const where = {
    tenantId: auth.tenantId,
    formId,
    deletedAt: null,
    ...(filters.status ? { status: filters.status } : {}),
  };
  const items = await prisma.marketingFormSubmission.findMany({ where, orderBy: { receivedAt: 'desc' } });
  return { items, total: items.length };
}

/** Kept for `domains/marketing/index.ts`'s barrel export. */
export const submitFormResponse = submitPublicForm;

// ---------------------------------------------------------------------------
// Detector: unconverted submissions (EX-MKT-007 / MKT-CAP-003)
// ---------------------------------------------------------------------------

const DEFAULT_UNCONVERTED_SLA_HOURS = 24;

export async function detectUnconvertedSubmissions(hours: number = DEFAULT_UNCONVERTED_SLA_HOURS): Promise<number> {
  const auth = currentAuth();
  const cutoff = new Date(Date.now() - hours * 3_600_000);

  const stale = await prisma.marketingFormSubmission.findMany({
    where: { tenantId: auth.tenantId, status: 'received', deletedAt: null, receivedAt: { lt: cutoff } },
    take: 200,
  });

  for (const submission of stale) {
    await raiseException({
      code: 'EX-MKT-007',
      label: 'Form submission unconverted for 24h',
      severity: 'S1_ATTENTION',
      domain: 'mkt',
      subjectType: 'marketing_form_submission',
      subjectId: submission.id,
      subjectLabel: submission.recordCode,
      detail: `No conversion recorded ${hours}h after this form submission was received.`,
      triggerFingerprint: `form_submission_unconverted:${hours}`,
      ladderRung: 0,
    });
  }

  return stale.length;
}

// ---------------------------------------------------------------------------
// Short links
// ---------------------------------------------------------------------------

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += BASE62[bytes[i] % BASE62.length];
  return out;
}

export interface ShortLinkInput {
  slug?: string;
  targetUrl: string;
  campaignId?: string | null;
  channelKey?: ChannelKey | null;
  utm?: Record<string, unknown>;
}

export async function createShortLink(input: ShortLinkInput) {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'create' });

  if (input.channelKey && !CHANNEL_KEYS.includes(input.channelKey)) {
    throw ApiError.badRequest(`channelKey must be one of ${CHANNEL_KEYS.join(', ')}.`);
  }

  const recordCode = await nextRecordCode('LNK');

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = input.slug ?? randomBase62(6);
    try {
      return await prisma.marketingShortLink.create({
        data: {
          tenantId: auth.tenantId,
          recordCode,
          slug,
          targetUrl: input.targetUrl,
          campaignId: input.campaignId ?? null,
          channelKey: input.channelKey ?? null,
          utm: (input.utm ?? {}) as never,
          createdById: auth.partyId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && !input.slug) continue;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw ApiError.conflict(`A short link with slug '${input.slug}' already exists.`);
      }
      throw err;
    }
  }
  throw ApiError.internal('Could not allocate a unique short-link slug after several attempts.');
}

export async function listShortLinks() {
  const auth = currentAuth();
  await assertCan({ resource: 'marketing_forms', verb: 'view' });
  const items = await prisma.marketingShortLink.findMany({ where: { tenantId: auth.tenantId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  return { items, total: items.length };
}

function appendUtmParams(targetUrl: string, utm: Record<string, unknown>): string {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    // A relative target — build the query string manually rather than fail.
    const [base, existingQuery] = targetUrl.split('?');
    const params = new URLSearchParams(existingQuery ?? '');
    for (const [k, v] of Object.entries(utm)) {
      if (v === undefined || v === null || v === '') continue;
      params.set(k.startsWith('utm_') ? k : `utm_${k}`, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }
  for (const [k, v] of Object.entries(utm)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k.startsWith('utm_') ? k : `utm_${k}`, String(v));
  }
  return url.toString();
}

/** MKT-CAP-004-adjacent: a click is itself a touchpoint, recorded before the redirect happens — no auth (public route). */
export async function resolveAndClick(slug: string, meta: SubmitMeta = {}): Promise<{ targetUrl: string }> {
  const link = await unscopedPrisma.marketingShortLink.findFirst({ where: { slug } });
  if (!link || link.deletedAt) throw ApiError.notFound('Short link');

  return asSystem(link.tenantId, async () => {
    await prisma.marketingShortLink.update({ where: { id: link.id }, data: { clickCount: { increment: 1 } } });

    const utm = (link.utm as Record<string, unknown>) ?? {};
    await recordTouchpoint({
      campaignId: link.campaignId,
      channelKey: link.channelKey ?? 'website',
      touchKind: 'click',
      utm,
      sourceRef: link.slug,
    });

    return { targetUrl: appendUtmParams(link.targetUrl, utm) };
  });
}

// ---------------------------------------------------------------------------
// Inbound webhooks
// ---------------------------------------------------------------------------

const KNOWN_WEBHOOK_PROVIDERS = new Set(['email', 'sms', 'whatsapp', 'forms']);

export interface WebhookMeta {
  tenantSlug?: string;
  ip?: string;
  userAgent?: string;
}

/**
 * Tenant resolution for a provider webhook: the `X-Kai-Tenant` header or a
 * `tenant` query param, carrying the tenant's slug — documented here because
 * there is no session to resolve it from. A tenant that does not resolve is a
 * 400 (the caller's webhook is misconfigured, not a marketing-domain concern);
 * an unrecognised *provider*, once the tenant IS known, is what stores as
 * `status: 'unrouted'` and still answers 202 — never silently dropped.
 */
export async function receiveWebhook(provider: string, payload: Record<string, unknown>, meta: WebhookMeta = {}) {
  if (!meta.tenantSlug) throw ApiError.badRequest('Webhook requires X-Kai-Tenant header or ?tenant= query param.');
  const tenant = await unscopedPrisma.tenant.findFirst({ where: { slug: meta.tenantSlug, status: 'active' } });
  if (!tenant) throw ApiError.badRequest(`Unknown tenant '${meta.tenantSlug}'.`);

  return asSystem(tenant.id, async () => {
    const row = await prisma.marketingWebhookInbound.create({
      data: {
        tenantId: tenant.id,
        recordCode: internalCode('WHK'),
        provider,
        eventKind: typeof payload.event === 'string' ? payload.event : 'unknown',
        payload: payload as never,
        status: 'received',
      },
    });

    if (!KNOWN_WEBHOOK_PROVIDERS.has(provider)) {
      await prisma.marketingWebhookInbound.update({ where: { id: row.id }, data: { status: 'unrouted' } });
      await emit({
        name: EVENTS.MKT_WEBHOOK_RECEIVED,
        subject: { entityType: 'marketing_webhook_inbound', entityId: row.id, recordCode: row.recordCode },
        newState: { provider, status: 'unrouted' },
      });
      return { accepted: true, status: 'unrouted' as const };
    }

    try {
      if (provider === 'forms') {
        const formToken = payload.formToken;
        if (typeof formToken !== 'string' || !formToken) {
          throw ApiError.badRequest("A 'forms' webhook payload requires a formToken field.");
        }
        await submitPublicForm(formToken, payload, { ip: meta.ip, userAgent: meta.userAgent });
      } else {
        const adapter = getAdapter(provider as ChannelKey);
        const events = adapter.parseInboundWebhook?.(payload) ?? [];
        await applyDeliveryEvents(provider, events);
      }

      const processed = await prisma.marketingWebhookInbound.update({
        where: { id: row.id },
        data: { status: 'processed', processedAt: new Date() },
      });

      await emit({
        name: EVENTS.MKT_WEBHOOK_RECEIVED,
        subject: { entityType: 'marketing_webhook_inbound', entityId: row.id, recordCode: row.recordCode },
        newState: { provider, status: 'processed' },
      });

      return { accepted: true, status: processed.status };
    } catch (err) {
      await prisma.marketingWebhookInbound.update({
        where: { id: row.id },
        data: { status: 'failed', error: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  });
}
