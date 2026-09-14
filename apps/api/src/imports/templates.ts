/**
 * The templates you fill in.
 *
 * Everything else in this module reads files somebody else's software wrote —
 * a Tally export, a bank statement, whatever the payroll spreadsheet happens to
 * look like this year — and works hard to cope with all of them. That is the
 * right posture for those, because the company does not control their shape.
 *
 * It is the wrong posture for the company's own lists. "Import your students"
 * against a free-form spreadsheet means guessing which column is the batch and
 * what "TCE" refers to, and guessing wrong quietly. So for the things we do
 * control, the platform states the shape: download a file with the right
 * headings on it, fill it in, upload it back.
 *
 * One spec per kind, used three times — to write the blank file, to recognise
 * a filled one on the way back in, and to read its columns. They cannot drift
 * apart, because there is only one of them.
 *
 * The blank sheet carries headings and no example rows. Examples live on the
 * instructions sheet instead, where they cannot be uploaded by accident: a
 * demonstration row left in by mistake becomes a real student, and finding that
 * out later is worse than the two seconds it saves.
 *
 * Required headings are worded so that no two templates share their whole set —
 * "Contact name" and "Staff name" rather than "Name" twice. Recognition is by
 * the required headings, so two templates that shared them would be told apart
 * by a tie-break, and a tie-break deciding whether a row becomes a colleague or
 * a client's contact is not a tie-break worth having.
 */

import * as XLSX from 'xlsx';
import type { Grid } from './parse.js';

export type TemplateKind =
  | 'template_courses'
  | 'template_batches'
  | 'template_colleges'
  | 'template_clients'
  | 'template_students'
  | 'template_contacts'
  | 'template_staff'
  | 'template_ledger_accounts'
  | 'template_ledger_categories'
  | 'template_vendor_bills'
  | 'template_opening_register';

export interface TemplateColumn {
  /** The heading written into the file, and matched on the way back. */
  name: string;
  /** The key the extractor produces. */
  field: string;
  required?: boolean;
  /** What it means, in the words somebody filling this in would use. */
  note: string;
  example: string;
  /** How to read the cell. Dates and numbers are coerced; everything else is text. */
  as?: 'text' | 'number' | 'date' | 'yesno';
}

export interface TemplateSpec {
  kind: TemplateKind;
  /** The filename stem and the URL segment. */
  slug: string;
  title: string;
  /** One line: what this list is. */
  what: string;
  /** What has to exist before this can be imported, if anything. */
  needsFirst?: string;
  columns: TemplateColumn[];
  notes: string[];
}

const SPECS: TemplateSpec[] = [
  {
    kind: 'template_courses',
    slug: 'courses',
    title: 'Courses',
    what: 'What you teach. A course is the syllabus; a batch is one run of it.',
    columns: [
      { name: 'Course name', field: 'name', required: true, note: 'What you call it.', example: 'Full Stack Development' },
      { name: 'Course code', field: 'code', required: true, note: 'Short and unique. Used to point batches at this course.', example: 'FSD-101' },
      { name: 'Duration (weeks)', field: 'durationWeeks', note: 'A whole number of weeks. Leave blank if it varies.', example: '12', as: 'number' },
      { name: 'Description', field: 'description', note: 'Optional.', example: 'React, Node and PostgreSQL, project-led.' },
    ],
    notes: [
      'A course code that already exists is skipped rather than duplicated, so re-uploading a corrected file is safe.',
    ],
  },
  {
    kind: 'template_batches',
    slug: 'batches',
    title: 'Training batches',
    what: 'Each run of a course: when it goes, how many it holds, and whose campus it runs on.',
    needsFirst: 'Courses, and Colleges if a batch runs on a campus.',
    columns: [
      { name: 'Course code', field: 'courseCode', required: true, note: 'Must match a course code you have already imported or created.', example: 'FSD-101' },
      { name: 'Batch name', field: 'name', required: true, note: 'How you refer to this run. Students point at it by this name.', example: 'FSD — Sept 2026, Madurai' },
      { name: 'Starts', field: 'startDate', required: true, note: 'DD/MM/YYYY.', example: '15/09/2026', as: 'date' },
      { name: 'Ends', field: 'endDate', note: 'DD/MM/YYYY. Leave blank if it is not fixed.', example: '10/12/2026', as: 'date' },
      { name: 'Capacity', field: 'capacity', note: 'Seats. Leave blank for 30.', example: '30', as: 'number' },
      { name: 'Runs at (college)', field: 'institutionName', note: 'The college hosting it, if any. Must already be on file as a college.', example: 'Thiagarajar College of Engineering' },
    ],
    notes: [
      'Where a batch runs is a different fact from where each student came from. A batch on one campus can hold students from four colleges.',
    ],
  },
  {
    kind: 'template_colleges',
    slug: 'colleges',
    title: 'Colleges',
    what: 'Institutions you recruit students from.',
    columns: [
      { name: 'College name', field: 'name', required: true, note: 'The full name, as it is written on their letterhead.', example: 'Thiagarajar College of Engineering' },
      { name: 'Kind', field: 'institutionType', note: 'Engineering college, arts & science college, polytechnic, university, school or ITI.', example: 'Engineering college' },
      { name: 'Management', field: 'managementType', note: 'Government, aided, self-financing, autonomous or private.', example: 'Autonomous' },
      { name: 'District', field: 'district', note: '', example: 'Madurai' },
      { name: 'State', field: 'state', note: '', example: 'Tamil Nadu' },
      { name: 'Students on campus', field: 'studentCount', note: 'Roughly. Leave blank rather than guessing.', example: '5200', as: 'number' },
      { name: 'Established', field: 'establishedYear', note: 'Year.', example: '1957', as: 'number' },
      { name: 'Website', field: 'website', note: '', example: 'https://www.tce.edu' },
      { name: 'Also a client?', field: 'alsoAClient', note: 'Yes if you also invoice them. A college can be both.', example: 'No', as: 'yesno' },
    ],
    notes: [
      'A college on this list is marked as a college, which is what lets students be recorded as having come from it.',
      'A name already on file gains the college marking rather than becoming a second record.',
    ],
  },
  {
    kind: 'template_clients',
    slug: 'clients',
    title: 'Client companies',
    what: 'Companies you invoice.',
    columns: [
      { name: 'Company name', field: 'name', required: true, note: 'The registered name.', example: 'Sundaram Textiles Ltd' },
      { name: 'Website', field: 'website', note: '', example: 'https://sundaramtextiles.in' },
      { name: 'Tier', field: 'tier', note: 'Strategic, key or standard. Leave blank if you do not tier them.', example: 'Key' },
      { name: 'Payment terms (days)', field: 'paymentTermsDays', note: 'Leave blank for 30.', example: '45', as: 'number' },
      { name: 'Billing email', field: 'billingEmail', note: 'Where invoices go.', example: 'accounts@sundaramtextiles.in' },
      { name: 'Billing address', field: 'billingAddress', note: '', example: '14 Bypass Road, Madurai 625010' },
    ],
    notes: ['A name already on file gains the client marking rather than becoming a second record.'],
  },
  {
    kind: 'template_students',
    slug: 'students',
    title: 'Students',
    what: 'Who is on which batch, and which college they came from.',
    needsFirst: 'Training batches, and Colleges if the students were recruited from one.',
    columns: [
      { name: 'Student name', field: 'fullName', required: true, note: 'Their full name.', example: 'Karthik Raman' },
      { name: 'Phone', field: 'primaryPhone', note: 'How a repeat student is recognised as the same person. Worth filling in.', example: '9843012345' },
      { name: 'Email', field: 'primaryEmail', note: '', example: 'karthik.raman@example.com' },
      { name: 'Batch name', field: 'cohortName', required: true, note: 'Must match a batch name exactly.', example: 'FSD — Sept 2026, Madurai' },
      { name: 'From (college)', field: 'institutionName', note: 'The college they came from. Leave blank for a direct enrolment.', example: 'Thiagarajar College of Engineering' },
      { name: 'Under 18?', field: 'isMinor', note: 'Yes or No. If yes, a guardian contact is required.', example: 'No', as: 'yesno' },
      { name: 'Guardian name', field: 'guardianName', note: 'Only for a student under 18.', example: '' },
      { name: 'Guardian phone', field: 'guardianPhone', note: 'Required for a student under 18.', example: '' },
    ],
    notes: [
      'A phone or email that matches somebody already on file enrols that person rather than creating a second copy of them.',
      'A student under 18 with no guardian phone or email is refused, not imported half-filled.',
      "Guardian contact is regulated under the DPDP Act: it is read-audited, and withheld from anybody whose clearance does not reach it.",
    ],
  },
  {
    kind: 'template_contacts',
    slug: 'contacts',
    title: 'Contacts',
    what: 'People at the companies and colleges you deal with.',
    needsFirst: 'The companies or colleges they belong to, if you want them linked.',
    columns: [
      { name: 'Contact name', field: 'fullName', required: true, note: '', example: 'Meena Sundaram' },
      { name: 'Phone', field: 'primaryPhone', note: '', example: '9840011223' },
      { name: 'Email', field: 'primaryEmail', note: '', example: 'meena@sundaramtextiles.in' },
      { name: 'Organisation', field: 'organizationName', note: 'The company or college they are at. Must already be on file.', example: 'Sundaram Textiles Ltd' },
      { name: 'Job title', field: 'jobTitle', note: '', example: 'Head of Learning & Development' },
    ],
    notes: [
      'Somebody at a company you deal with is a contact. Somebody on a batch is a student, and belongs on the Students list instead — the same person can be both, and stays one record.',
    ],
  },
  {
    kind: 'template_staff',
    slug: 'staff',
    title: 'Staff',
    what: 'Your own people.',
    columns: [
      { name: 'Staff name', field: 'fullName', required: true, note: '', example: 'Anitha Devi' },
      { name: 'Employee code', field: 'employeeCode', note: 'Yours, if you use them.', example: 'KI-014' },
      { name: 'Designation', field: 'designation', note: '', example: 'Senior Engineer' },
      { name: 'Division', field: 'division', note: 'Software, Skill Development, Education or Shared.', example: 'Software' },
      { name: 'Branch', field: 'branch', note: 'Where they sit.', example: 'Madurai' },
      { name: 'Phone', field: 'phone', note: '', example: '9843055667' },
      { name: 'Email', field: 'email', note: '', example: 'anitha@kaizen.co.in' },
      { name: 'Date of birth', field: 'dateOfBirth', note: 'DD/MM/YYYY.', example: '02/06/1994', as: 'date' },
      { name: 'Joining date', field: 'joiningDate', note: 'DD/MM/YYYY.', example: '01/04/2024', as: 'date' },
      { name: 'Blood group', field: 'bloodGroup', note: '', example: 'O+' },
    ],
    notes: [
      'Pay is deliberately not on this list. A salary is a separate act with its own approval, and a spreadsheet of them arriving through an import is how pay changes without anybody signing for them.',
    ],
  },
  {
    kind: 'template_ledger_accounts',
    slug: 'ledger-accounts',
    title: 'Bank & cash accounts',
    what: 'Somewhere money sits: a bank account, cash in hand, a card, a loan account.',
    columns: [
      { name: 'Account name', field: 'name', required: true, note: 'How you refer to it.', example: 'HDFC Current — Madurai' },
      { name: 'Type', field: 'accountType', note: 'Bank, Cash, Card, Loan or Wallet. Leave blank for Bank.', example: 'Bank' },
      { name: 'Last 4 digits', field: 'displayReference', note: 'Never the full number.', example: '4821' },
      { name: 'Opening balance', field: 'openingBalance', note: 'What it held on the opening date. Leave blank for zero.', example: '185000', as: 'number' },
      { name: 'Opening date', field: 'openingDate', note: 'DD/MM/YYYY. The date the opening balance is as of.', example: '01/04/2026', as: 'date' },
    ],
    notes: [
      'A name already on file is left alone rather than duplicated, so re-uploading a corrected file is safe.',
      'A card or a loan account is carried as a liability; everything else as an asset — worked out from the type, not asked separately.',
    ],
  },
  {
    kind: 'template_ledger_categories',
    slug: 'ledger-categories',
    title: 'Income & expense categories',
    what: "The company's own chart: what money is earned or spent under. Not a statutory chart.",
    columns: [
      { name: 'Category name', field: 'name', required: true, note: 'What you call it.', example: 'Building Rent' },
      { name: 'Type', field: 'kind', note: 'Income, Expense, Asset purchase, Tax, Transfer, Equity or Drawings. Leave blank for Expense.', example: 'Expense' },
      { name: 'How it behaves', field: 'behaviour', note: 'Recurring fixed, Variable, One-time or Annual. Leave blank for Variable.', example: 'Recurring fixed' },
      { name: 'Parent category', field: 'parentName', note: 'The category this sits under, if any. Must already be on file.', example: '' },
      { name: 'Usually which division', field: 'defaultDivision', note: 'Software, Skill Development, Education or Shared. Overridable per entry.', example: 'Shared' },
      { name: 'Cannot be deferred?', field: 'mustPay', note: 'Yes for rent, salaries, statutory dues — a cost the company cannot put off.', example: 'No', as: 'yesno' },
    ],
    notes: [
      'A name already on file is left alone rather than duplicated, so re-uploading a corrected file is safe.',
      'A parent category is not created on the fly — it must already be on file. Import the top-level categories first with Parent left blank, then a second file for the ones under them.',
    ],
  },
  {
    kind: 'template_vendor_bills',
    slug: 'vendor-bills',
    title: 'Bills to pay',
    what: 'What a supplier is owed, as of the day you are bringing your books in. The other half of receivables.',
    needsFirst: 'Ledger categories, if you want a bill put under a spending category.',
    columns: [
      { name: 'Vendor name', field: 'vendorName', required: true, note: 'The supplier.', example: 'ARA Systems' },
      { name: 'Vendor GSTIN', field: 'vendorGstin', note: '', example: '33AABCA1234H1Z8' },
      { name: 'Bill number', field: 'billNumber', required: true, note: "The supplier's own number, or one you invent for a bill that never had one.", example: 'ARA/2026/0142' },
      { name: 'Bill date', field: 'billDate', required: true, note: 'DD/MM/YYYY.', example: '12/08/2026', as: 'date' },
      { name: 'Due date', field: 'dueDate', note: 'DD/MM/YYYY. Leave blank if there is no term.', example: '11/09/2026', as: 'date' },
      { name: 'Category', field: 'categoryName', note: 'What it was for. Must already be on file. Leave blank to categorise later.', example: 'Office supplies' },
      { name: 'Division', field: 'division', note: 'Software, Skill Development, Education or Shared.', example: 'Shared' },
      { name: 'Amount before GST', field: 'subtotal', required: true, note: '', example: '42000', as: 'number' },
      { name: 'GST', field: 'taxAmount', note: 'Leave blank for zero.', example: '7560', as: 'number' },
      { name: 'Note', field: 'note', note: '', example: '' },
    ],
    notes: [
      'A bill already on file under the same vendor and bill number is left alone rather than duplicated, so re-uploading a corrected file is safe.',
      'Every bill lands unpaid — this is a list of what is owed, not a record of what has already been settled. Record a payment against it afterwards, the same way as any bill entered by hand.',
    ],
  },
  {
    kind: 'template_opening_register',
    slug: 'opening-register',
    title: 'Opening register',
    what: 'The share register as it stands today — holders, classes and the allotments already made — so the first cap table is not typed in by hand.',
    columns: [
      { name: 'Holder name', field: 'holderName', required: true, note: 'Full name of the person, or the registered name of the organisation.', example: 'Karthik Raman' },
      { name: 'Holder kind', field: 'holderKind', required: true, note: 'Person or Organisation.', example: 'Person' },
      { name: 'Email', field: 'email', note: '', example: 'karthik@example.com' },
      { name: 'Phone', field: 'phone', note: '', example: '9843012345' },
      { name: 'PAN', field: 'panNumber', note: 'Optional.', example: 'ABCDE1234F' },
      { name: 'Residency', field: 'residency', note: 'Resident or Non-resident. Leave blank for Resident.', example: 'Resident' },
      { name: 'Investment basis', field: 'investmentBasis', note: 'Repatriable or Non-repatriable. Required only for a non-resident holder.', example: '' },
      { name: 'Share class', field: 'shareClassName', required: true, note: 'A new class is created if this name is not already on file, provided face value and instrument are also given.', example: 'Equity' },
      { name: 'Instrument', field: 'instrument', note: 'Equity, Preference, etc. Required when the class is new.', example: 'Equity' },
      { name: 'Face value', field: 'faceValue', note: 'Required when the class is new.', example: '10', as: 'number' },
      { name: 'Count', field: 'count', required: true, note: 'Number of shares.', example: '1000', as: 'number' },
      { name: 'Distinctive from', field: 'distinctiveFrom', required: true, note: 'The first distinctive number in the range on the existing certificate.', example: '1', as: 'number' },
      { name: 'Distinctive to', field: 'distinctiveTo', required: true, note: 'The last distinctive number in the range.', example: '1000', as: 'number' },
      { name: 'Allotted on', field: 'allottedOn', required: true, note: 'DD/MM/YYYY.', example: '01/04/2020', as: 'date' },
      { name: 'Price per share', field: 'pricePerShare', note: 'Leave blank if not known.', example: '10', as: 'number' },
      { name: 'Certificate number', field: 'certificateNumber', note: 'The number already printed on the paper certificate, if one exists.', example: 'KIPL/C/20-21/001' },
    ],
    notes: [
      'Every row becomes an effective allotment, dated as given — this is the opening position, not a proposal working through approval.',
      'A distinctive range that overlaps another row already on file, or another row in this same file, within the same share class, is refused rather than imported.',
      'A certificate number given here is kept exactly as written rather than allocated from this platform’s own certificate series — it is the paper the holder is already holding.',
    ],
  },
];

export const TEMPLATES: Record<string, TemplateSpec> = Object.fromEntries(SPECS.map((s) => [s.slug, s]));

export const templateBySlug = (slug: string): TemplateSpec | undefined => TEMPLATES[slug];

export const templateByKind = (kind: string): TemplateSpec | undefined =>
  SPECS.find((s) => s.kind === kind);

/** What the download list shows. */
export function listTemplates() {
  return SPECS.map((s) => ({
    slug: s.slug,
    kind: s.kind,
    title: s.title,
    what: s.what,
    needsFirst: s.needsFirst ?? null,
    columns: s.columns.map((c) => ({ name: c.name, required: Boolean(c.required), note: c.note })),
    notes: s.notes,
  }));
}

// ---------------------------------------------------------------------------
// Writing the blank file
// ---------------------------------------------------------------------------

/**
 * A workbook with two sheets: the one you type into, and the one that explains
 * it.
 *
 * Kept as .xlsx rather than .csv because the instructions have to travel with
 * the file. A CSV with a header row and nothing else leaves the person to guess
 * what "Management" wants, and they guess in the file.
 */
export function buildTemplateWorkbook(spec: TemplateSpec): Buffer {
  const book = XLSX.utils.book_new();

  // Sheet one: the headings, and nothing under them.
  const data = XLSX.utils.aoa_to_sheet([spec.columns.map((c) => c.name)]);
  data['!cols'] = spec.columns.map((c) => ({ wch: Math.max(14, Math.min(38, c.name.length + 6)) }));
  XLSX.utils.book_append_sheet(book, data, 'Data');

  // Sheet two: what each column wants, and one worked row.
  const guide: string[][] = [
    [spec.title],
    [spec.what],
    [],
    ...(spec.needsFirst ? [['Import these first:', spec.needsFirst], []] : []),
    ['Column', 'Required', 'What it means', 'Example'],
    ...spec.columns.map((c) => [c.name, c.required ? 'Yes' : '', c.note, c.example]),
    [],
    ['Worth knowing'],
    ...spec.notes.map((n) => [n]),
    [],
    ['How to use this file'],
    ['1. Type your rows into the Data sheet, under the headings that are already there.'],
    ['2. Do not rename or reorder the headings — they are how the file is recognised.'],
    ['3. Leave a cell blank when you do not know it. A blank is recorded as unknown; a guess is recorded as fact.'],
    ['4. Save, then upload it under Imports. Nothing is written until you have seen the preview and pressed commit.'],
  ];
  const help = XLSX.utils.aoa_to_sheet(guide);
  help['!cols'] = [{ wch: 26 }, { wch: 10 }, { wch: 62 }, { wch: 34 }];
  XLSX.utils.book_append_sheet(book, help, 'How to fill this in');

  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ---------------------------------------------------------------------------
// Recognising a filled-in one on the way back
// ---------------------------------------------------------------------------

const norm = (s: unknown): string => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Which template this grid is, if any.
 *
 * Matched on the required headings rather than on all of them, so deleting a
 * column you have no data for still works — which people do, and which should
 * not be an error.
 */
export function detectTemplate(grid: Grid): { spec: TemplateSpec; headerRow: number } | null {
  for (let i = 0; i < Math.min(grid.length, 10); i += 1) {
    const row = (grid[i] ?? []).map(norm).filter(Boolean);
    if (row.length === 0) continue;

    for (const spec of SPECS) {
      const required = spec.columns.filter((c) => c.required).map((c) => norm(c.name));
      if (required.length === 0) continue;
      if (!required.every((r) => row.includes(r))) continue;

      // Two templates could in principle share their required headings; the one
      // matching more of its optional headings too is the better answer.
      const optional = spec.columns.filter((c) => !c.required).map((c) => norm(c.name));
      const score = optional.filter((o) => row.includes(o)).length;
      const better = SPECS.filter((s) => s !== spec).some((s) => {
        const req = s.columns.filter((c) => c.required).map((c) => norm(c.name));
        if (!req.length || !req.every((r) => row.includes(r))) return false;
        return s.columns.filter((c) => !c.required).map((c) => norm(c.name)).filter((o) => row.includes(o)).length > score;
      });
      if (!better) return { spec, headerRow: i };
    }
  }
  return null;
}
