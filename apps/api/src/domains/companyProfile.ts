/**
 * Who the company is, on paper.
 *
 * This file exists because two things in the platform were structurally unable
 * to be correct without it. An invoice is not a list of lines with a total — it
 * is a statement by one registered person to another, and without the supplier's
 * legal name, address and GSTIN on the face of it, it is not a tax invoice and a
 * customer cannot claim the credit. A GST return is filed *under* a GSTIN; the
 * old summary endpoint produced figures with no registration attached to them,
 * which is a spreadsheet rather than a return.
 *
 * One row per tenant, created on first read from the tenant's own name so that
 * nothing has to check whether it exists. What it is created with is deliberately
 * incomplete rather than invented: a blank GSTIN is a fact about a company that
 * has not told us its GSTIN, and a plausible-looking placeholder would end up
 * printed on a document somebody hands to a customer.
 */

import { EVENTS, isValidGstin, stateCodeOf, stateNameFor } from '@kaizen/shared';
import { prefixFrom, type YearFormat } from '../platform/documentNumber.js';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { ApiError } from '../platform/errors.js';
import { assertCan } from '../platform/permissions.js';
import { auditWrite } from '../platform/audit.js';
import { emit } from '../platform/eventBus.js';

export interface CompanyProfileInput {
  legalName?: string;
  tradeName?: string | null;
  gstin?: string | null;
  stateCode?: string | null;
  pan?: string | null;
  cin?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  pincode?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  bankBranch?: string | null;
  upiId?: string | null;
  invoiceTerms?: string | null;
  invoiceNotes?: string | null;
  defaultDueDays?: number;
  documentPrefix?: string | null;
  documentYearFormat?: YearFormat;
  // The register (equity-portal plan §5 "EntityProfile").
  incorporatedOn?: string | null;
  financialYearEndMonth?: number | null;
  isSmallCompany?: boolean | null;
  dematStatus?: 'physical' | 'demat' | 'mixed';
  isin?: string | null;
  rtaName?: string | null;
  dpiitNumber?: string | null;
  dpiitRecognisedOn?: string | null;
  iac80CertificateRef?: string | null;
  certificateSignatories?: Array<{ name: string; designation: string }>;
}

/** 12 characters, starting `INE` for an Indian ISIN. */
function isValidIsin(isin: string): boolean {
  return /^INE[A-Z0-9]{9}$/.test(isin);
}

/**
 * The profile, creating it on first read.
 *
 * Read by the invoice document, the GST return and the settings screen, so it
 * has to answer rather than 404: a company that has not filled its details in
 * still needs to be able to open the screen that fills them in.
 */
export async function companyProfile() {
  const auth = currentAuth();
  const existing = await prisma.companyProfile.findFirst({ where: { tenantId: auth.tenantId } });
  if (existing) return existing;

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { id: auth.tenantId } });
  return prisma.companyProfile.create({
    data: { tenantId: auth.tenantId, legalName: tenant.name },
  });
}

export async function updateCompanyProfile(input: CompanyProfileInput) {
  await assertCan({ resource: 'company_profile', verb: 'edit' });
  const current = await companyProfile();

  // A GSTIN that is not one is refused here rather than accepted and discovered
  // by the portal three weeks later, when the return it was filed in comes back
  // rejected with nothing to say which field caused it.
  if (input.gstin) {
    const gstin = input.gstin.trim().toUpperCase();
    if (!isValidGstin(gstin)) {
      throw ApiError.badRequest(
        `${gstin} is not a valid GSTIN. It is fifteen characters: a state code, a PAN, an entity number, a Z, and a check digit that has to agree with the rest.`,
      );
    }
    input.gstin = gstin;
    // The state code is the GSTIN's own first two digits. Asking for it
    // separately and then believing the answer is how a company comes to be
    // registered in one state and charging tax as though it were in another.
    input.stateCode = gstin.slice(0, 2);
  }

  const stateCode = input.stateCode ?? current.stateCode;

  if (input.isin) {
    const isin = input.isin.trim().toUpperCase();
    if (!isValidIsin(isin)) {
      throw ApiError.badRequest(`${isin} is not a valid ISIN. It is twelve characters and, for an India-issued security, starts INE.`);
    }
    input.isin = isin;
  }

  const updated = await prisma.companyProfile.update({
    where: { id: current.id },
    data: {
      ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
      ...(input.tradeName !== undefined ? { tradeName: input.tradeName } : {}),
      ...(input.gstin !== undefined ? { gstin: input.gstin } : {}),
      ...(input.stateCode !== undefined ? { stateCode: input.stateCode } : {}),
      ...(stateCode ? { stateName: stateNameFor(stateCode) } : {}),
      ...(input.pan !== undefined ? { pan: input.pan } : {}),
      ...(input.cin !== undefined ? { cin: input.cin } : {}),
      ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
      ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
      ...(input.city !== undefined ? { city: input.city } : {}),
      ...(input.pincode !== undefined ? { pincode: input.pincode } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.bankName !== undefined ? { bankName: input.bankName } : {}),
      ...(input.bankAccountName !== undefined ? { bankAccountName: input.bankAccountName } : {}),
      ...(input.bankAccountNumber !== undefined ? { bankAccountNumber: input.bankAccountNumber } : {}),
      ...(input.bankIfsc !== undefined ? { bankIfsc: input.bankIfsc } : {}),
      ...(input.bankBranch !== undefined ? { bankBranch: input.bankBranch } : {}),
      ...(input.upiId !== undefined ? { upiId: input.upiId } : {}),
      ...(input.invoiceTerms !== undefined ? { invoiceTerms: input.invoiceTerms } : {}),
      ...(input.invoiceNotes !== undefined ? { invoiceNotes: input.invoiceNotes } : {}),
      ...(input.defaultDueDays !== undefined ? { defaultDueDays: input.defaultDueDays } : {}),
      ...(input.documentPrefix !== undefined
        ? { documentPrefix: input.documentPrefix?.trim().toUpperCase() || null }
        : {}),
      ...(input.documentYearFormat !== undefined ? { documentYearFormat: input.documentYearFormat } : {}),
      ...(input.incorporatedOn !== undefined ? { incorporatedOn: input.incorporatedOn ? new Date(input.incorporatedOn) : null } : {}),
      ...(input.financialYearEndMonth !== undefined ? { financialYearEndMonth: input.financialYearEndMonth } : {}),
      ...(input.isSmallCompany !== undefined ? { isSmallCompany: input.isSmallCompany } : {}),
      ...(input.dematStatus !== undefined ? { dematStatus: input.dematStatus } : {}),
      ...(input.isin !== undefined ? { isin: input.isin } : {}),
      ...(input.rtaName !== undefined ? { rtaName: input.rtaName } : {}),
      ...(input.dpiitNumber !== undefined ? { dpiitNumber: input.dpiitNumber } : {}),
      ...(input.dpiitRecognisedOn !== undefined ? { dpiitRecognisedOn: input.dpiitRecognisedOn ? new Date(input.dpiitRecognisedOn) : null } : {}),
      ...(input.iac80CertificateRef !== undefined ? { iac80CertificateRef: input.iac80CertificateRef } : {}),
      ...(input.certificateSignatories !== undefined ? { certificateSignatories: input.certificateSignatories as never } : {}),
    },
  });

  await auditWrite({
    action: 'update',
    subjectType: 'company_profile',
    subjectId: updated.id,
    // The bank account number is not in the audit body. It is printed on
    // invoices on purpose and it is still not something to scatter through an
    // append-only log keyed by nothing in particular.
    before: { gstin: current.gstin, legalName: current.legalName },
    after: { gstin: updated.gstin, legalName: updated.legalName },
  });

  await emit({
    name: EVENTS.COMPANY_PROFILE_UPDATED,
    subject: { entityType: 'company_profile', entityId: updated.id },
    newState: { gstin: updated.gstin, stateCode: updated.stateCode },
    impact: { domains: ['fin'] },
  });

  return updated;
}

/**
 * The short code every customer-facing document number begins with.
 *
 * One function, because an invoice numbered `KIPL/I/…` and a receipt numbered
 * `KI/R/…` would be two companies as far as a customer is concerned.
 */
export async function documentPrefix(): Promise<string> {
  return prefixFrom(await companyProfile());
}

/**
 * Everything a document number is built from, in one read.
 *
 * Two values that have to agree — the prefix and how the year is written — and
 * fetching them separately is how an invoice and the receipt against it come to
 * disagree about which year it is.
 */
export async function documentNumbering(): Promise<{ prefix: string; yearFormat: YearFormat }> {
  const profile = await companyProfile();
  return {
    prefix: prefixFrom(profile),
    yearFormat: (profile.documentYearFormat as YearFormat) ?? 'short',
  };
}

/**
 * The supplier side of a tax invoice, and what a return is filed under.
 *
 * Separated from the row so the two callers that need only these fields cannot
 * accidentally print a bank account or an invoice footer where they meant to
 * print a registration.
 */
export async function supplyingParty() {
  const profile = await companyProfile();
  return {
    legalName: profile.legalName,
    tradeName: profile.tradeName,
    gstin: profile.gstin,
    stateCode: profile.stateCode ?? stateCodeOf(profile.gstin),
    stateName: profile.stateName ?? stateNameFor(profile.stateCode ?? stateCodeOf(profile.gstin)),
    registered: isValidGstin(profile.gstin),
  };
}

/**
 * Refuses an act that needs a registration when there is not one.
 *
 * Filing a return with no GSTIN is not a thing that can half-work, so it fails
 * with the sentence that says where to fix it rather than with a null deref
 * three frames further in.
 */
export async function assertRegistered(what: string) {
  const party = await supplyingParty();
  if (!party.registered) {
    throw ApiError.unprocessable(
      `${what} needs the company's own GSTIN, and the company profile does not carry a valid one yet. Set it under Settings → Company details.`,
    );
  }
  return party;
}
