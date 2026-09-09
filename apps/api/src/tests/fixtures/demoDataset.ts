/**
 * The demonstration dataset — test subjects, not product data.
 *
 * This was the shipped seed. Fifteen invented staff, a pipeline of fictional
 * deals across five commercial motions, an education cohort, seven months of a
 * ledger, and a set of records deliberately left broken so that every detector
 * and every surface had something real to show on first run.
 *
 * It was good at what it was for and wrong to ship. A company installing the
 * platform had to identify and delete somebody else's data before any figure on
 * their own dashboard meant anything, and until they had, the product was
 * confidently reporting a runway that was not theirs.
 *
 * So it lives here. Under `src/tests/` it is compiled for the suite and never
 * reachable from the server, and the 250-odd acceptance tests keep the subjects
 * they need — a lead to route, a deal to lose, a person to terminate, a
 * disputed attendance day inside an open payroll period.
 *
 * Role slugs are remapped on the way in. The dataset was written against
 * sixteen roles and the register now holds three, so each demo person carries
 * the role their behaviour in the tests actually requires.
 */

import { randomUUID } from 'node:crypto';
import {
  EVENTS,
  type DeliveryModel,
  type RevenueTreatment,
  type Vertical,
} from '@kaizen/shared';
import { prisma } from '../../platform/db.js';
import { asSystem } from '../../platform/context.js';
import { hashPassword } from '../../lib/auth.js';
import { nextRecordCode } from '../../platform/recordCode.js';
import { seedBootstrap, TENANT_SLUG } from '../../seed/bootstrap.js';
import { computeAndPersistAll } from '../../domains/health.js';
import { runJobsForTenant } from '../../jobs/scheduler.js';
import { findOrCreatePerson } from '../../domains/identity.js';
import { seedDemoHr } from './demoHr.js';
import { seedDemoBooks } from './demoBooks.js';

const PASSWORD = 'kaizen2026';

const TAMIL_NADU_DISTRICTS = [
  'Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Tirunelveli',
  'Erode', 'Vellore', 'Thanjavur', 'Dindigul', 'Kanchipuram', 'Cuddalore',
];

/**
 * Sixteen demo roles onto three.
 *
 * The mapping is by authority, not by job title: anybody who had to reach the
 * ledger, approve something, or operate the people function becomes a
 * `finance_head`; anybody whose tests are about being narrowed to their own
 * record becomes an `employee`; the chairman stays the chairman. `divya` is
 * deliberately an employee — several tests exist precisely to prove that an
 * own-scoped principal cannot read a colleague's record.
 */
const ROLE_MAP: Record<string, string> = {
  chairman: 'chairman',
  system_admin: 'chairman',
  business_head: 'finance_head',
  director: 'finance_head',
  finance_controller: 'finance_head',
  finance: 'finance_head',
  hr_ops: 'finance_head',
  sales: 'finance_head',
  education_counsellor: 'finance_head',
  workforce_placement: 'finance_head',
  project_manager: 'employee',
  marketing: 'employee',
  telecaller: 'employee',
  trainer: 'employee',
};

const mapRole = (slug: string): string => ROLE_MAP[slug] ?? 'employee';

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * 86_400_000);
}

async function currentTenant() {
  return prisma.tenant.findFirstOrThrow({ where: { slug: TENANT_SLUG } });
}

// ---------------------------------------------------------------------------
// People, affiliations, users
// ---------------------------------------------------------------------------

interface SeededPerson {
  id: string;
  fullName: string;
  email: string;
  /** The demo role. The persisted affiliation carries `mapRole(roleSlug)`. */
  roleSlug: string;
  branch: string;
}

async function seedPeopleAndUsers(): Promise<SeededPerson[]> {
  const tenantId = (await currentTenant()).id;
  const passwordHash = await hashPassword(PASSWORD);

  const staff: Array<{ name: string; email: string; role: string; branch: string; phone: string; orgUnit: string }> = [
    { name: 'Ashok Raghunathan', email: 'chairman@kaizen.co.in', role: 'chairman', branch: 'Chennai', phone: '9840000001', orgUnit: 'exec' },
    { name: 'Vinodh Shankar', email: 'sysadmin@kaizen.co.in', role: 'system_admin', branch: 'Chennai', phone: '9840000002', orgUnit: 'platform' },
    { name: 'Nandini Krishnan', email: 'bhead@kaizen.co.in', role: 'business_head', branch: 'Chennai', phone: '9840000003', orgUnit: 'commercial' },
    { name: 'Rajesh Venkataraman', email: 'director@kaizen.co.in', role: 'director', branch: 'Coimbatore', phone: '9840000004', orgUnit: 'commercial' },
    { name: 'Latha Subramanian', email: 'controller@kaizen.co.in', role: 'finance_controller', branch: 'Chennai', phone: '9840000005', orgUnit: 'finance' },
    { name: 'Arun Prakash', email: 'arun@kaizen.co.in', role: 'sales', branch: 'Chennai', phone: '9840000006', orgUnit: 'commercial' },
    { name: 'Sanjay Mehta', email: 'sanjay@kaizen.co.in', role: 'sales', branch: 'Coimbatore', phone: '9840000007', orgUnit: 'commercial' },
    { name: 'Divya Ramesh', email: 'divya@kaizen.co.in', role: 'telecaller', branch: 'Chennai', phone: '9840000008', orgUnit: 'commercial' },
    { name: 'Meera Nair', email: 'meera@kaizen.co.in', role: 'education_counsellor', branch: 'Madurai', phone: '9840000009', orgUnit: 'education' },
    { name: 'Ravi Chandran', email: 'ravi@kaizen.co.in', role: 'trainer', branch: 'Chennai', phone: '9840000010', orgUnit: 'education' },
    { name: 'Kavitha Selvam', email: 'kavitha@kaizen.co.in', role: 'project_manager', branch: 'Chennai', phone: '9840000011', orgUnit: 'delivery' },
    { name: 'Suresh Kumar', email: 'suresh@kaizen.co.in', role: 'workforce_placement', branch: 'Coimbatore', phone: '9840000012', orgUnit: 'placement' },
    { name: 'Priya Balan', email: 'priya@kaizen.co.in', role: 'marketing', branch: 'Chennai', phone: '9840000013', orgUnit: 'marketing' },
    { name: 'Lakshmi Iyer', email: 'latha@kaizen.co.in', role: 'finance', branch: 'Chennai', phone: '9840000014', orgUnit: 'finance' },
    { name: 'Bhavani Rajan', email: 'hr@kaizen.co.in', role: 'hr_ops', branch: 'Chennai', phone: '9840000016', orgUnit: 'corporate' },
    { name: 'Gopal Srinivasan', email: 'multi@kaizen.co.in', role: 'sales', branch: 'Chennai', phone: '9840000015', orgUnit: 'commercial' },
  ];

  const out: SeededPerson[] = [];

  for (const s of staff) {
    let person = await prisma.person.findFirst({ where: { tenantId, primaryEmail: s.email } });
    if (!person) {
      person = await prisma.person.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('PER'),
          fullName: s.name,
          primaryEmail: s.email,
          primaryEmailNormalised: s.email.toLowerCase(),
          primaryPhone: s.phone,
          primaryPhoneNormalised: s.phone,
          source: 'seed',
        },
      });
    }

    const existingAffiliation = await prisma.affiliation.findFirst({
      where: { tenantId, partyId: person.id, roleSlug: mapRole(s.role) },
    });
    if (!existingAffiliation) {
      await prisma.affiliation.create({
        data: {
          tenantId,
          partyId: person.id,
          affiliationType: 'employee',
          counterpartyName: 'Kaizen Infinities',
          roleSlug: mapRole(s.role),
          primaryFlag: true,
          branch: s.branch,
          orgUnitId: s.orgUnit,
          positionId: `pos_${s.role}`,
          // An employee affiliation carries a statutory retention floor: a
          // dedup match against it never auto-merges.
          statutoryRetentionFloor: true,
        },
      });
    }

    await prisma.user.upsert({
      where: { tenantId_email: { tenantId, email: s.email } },
      create: { tenantId, personId: person.id, email: s.email, passwordHash, branch: s.branch },
      update: { passwordHash, branch: s.branch },
    });

    // The demo role, not the mapped one. This struct is fixture-internal — the
    // dataset selects "the counsellor" or "the trainer" to build a realistic
    // set of relationships, and those distinctions still describe the people
    // even though the register no longer holds a role for each. What lands in
    // the database is the mapped role above.
    out.push({ id: person.id, fullName: s.name, email: s.email, roleSlug: s.role, branch: s.branch });
  }

  // A person holding several concurrent affiliations — the canonical case the
  // context switcher exists for. Switching is "which of my relationships am I
  // answerable as", not "which company am I logged into".
  const multi = out.find((p) => p.email === 'multi@kaizen.co.in')!;
  for (const extra of [
    { affiliationType: 'employee', roleSlug: 'project_manager', orgUnit: 'delivery' },
    { affiliationType: 'employee', roleSlug: 'workforce_placement', orgUnit: 'placement' },
  ]) {
    const exists = await prisma.affiliation.findFirst({ where: { tenantId, partyId: multi.id, roleSlug: mapRole(extra.roleSlug) } });
    if (!exists) {
      await prisma.affiliation.create({
        data: {
          tenantId,
          partyId: multi.id,
          affiliationType: extra.affiliationType,
          counterpartyName: 'Kaizen Infinities',
          roleSlug: mapRole(extra.roleSlug),
          branch: 'Chennai',
          orgUnitId: extra.orgUnit,
          statutoryRetentionFloor: true,
        },
      });
    }
  }

  // Capability claims feed the routing engine's Capability factor. Never
  // auto-asserted at `verified` tier.
  const claims = [
    { email: 'arun@kaizen.co.in', vertical: 'sap_enterprise', tier: 'verified' },
    { email: 'arun@kaizen.co.in', vertical: 'software_ai', tier: 'demonstrated' },
    { email: 'sanjay@kaizen.co.in', vertical: 'cybersecurity', tier: 'assessed' },
    { email: 'sanjay@kaizen.co.in', vertical: 'sap_enterprise', tier: 'assessed' },
    { email: 'meera@kaizen.co.in', vertical: 'education', tier: 'verified' },
    { email: 'meera@kaizen.co.in', vertical: 'partnerships', tier: 'demonstrated' },
    { email: 'suresh@kaizen.co.in', vertical: 'placement', tier: 'verified' },
    { email: 'divya@kaizen.co.in', vertical: 'education', tier: 'claimed' },
  ];
  for (const c of claims) {
    const person = out.find((p) => p.email === c.email);
    if (!person) continue;
    const exists = await prisma.capabilityClaim.findFirst({ where: { tenantId, partyId: person.id, vertical: c.vertical } });
    if (!exists) {
      await prisma.capabilityClaim.create({
        data: { tenantId, partyId: person.id, vertical: c.vertical, tier: c.tier, evidence: 'Seeded from historical win data.' },
      });
    }
  }

  console.log(`  ${out.length} staff with affiliations, users and capability claims`);
  return out;
}

async function seedAuthorityGrants(people: SeededPerson[]) {
  const tenantId = (await currentTenant()).id;

  const grants: Array<{ email: string; authorityClass: string; ceiling: number }> = [
    { email: 'bhead@kaizen.co.in', authorityClass: 'mou_approval', ceiling: 1_000_000 },
    { email: 'bhead@kaizen.co.in', authorityClass: 'contract_approval', ceiling: 2_000_000 },
    { email: 'bhead@kaizen.co.in', authorityClass: 'partner_approval', ceiling: 1_000_000 },
    { email: 'bhead@kaizen.co.in', authorityClass: 'commit_approval', ceiling: 10_000_000 },
    { email: 'director@kaizen.co.in', authorityClass: 'mou_approval', ceiling: 5_000_000 },
    { email: 'director@kaizen.co.in', authorityClass: 'contract_approval', ceiling: 10_000_000 },
    { email: 'director@kaizen.co.in', authorityClass: 'partner_approval', ceiling: 5_000_000 },
    { email: 'chairman@kaizen.co.in', authorityClass: 'mou_approval', ceiling: 100_000_000 },
    { email: 'chairman@kaizen.co.in', authorityClass: 'contract_approval', ceiling: 100_000_000 },
    { email: 'chairman@kaizen.co.in', authorityClass: 'partner_approval', ceiling: 100_000_000 },
    { email: 'chairman@kaizen.co.in', authorityClass: 'commit_approval', ceiling: 100_000_000 },
    { email: 'controller@kaizen.co.in', authorityClass: 'discount_approval', ceiling: 20_000_000 },
    // A rep holds a real but modest ceiling, so an over-ceiling deal opens a
    // step rather than being silently permitted.
    { email: 'arun@kaizen.co.in', authorityClass: 'discount_approval', ceiling: 500_000 },
    { email: 'arun@kaizen.co.in', authorityClass: 'mou_approval', ceiling: 100_000 },
  ];

  let count = 0;
  for (const g of grants) {
    const person = people.find((p) => p.email === g.email);
    if (!person) continue;
    const exists = await prisma.authorityGrant.findFirst({
      where: { tenantId, principalId: person.id, authorityClass: g.authorityClass },
    });
    if (exists) continue;
    await prisma.authorityGrant.create({
      data: {
        tenantId,
        principalType: 'human',
        principalId: person.id,
        principalLabel: person.fullName,
        authorityClass: g.authorityClass,
        ceilingValue: g.ceiling,
        currency: 'INR',
      },
    });
    count += 1;
  }
  console.log(`  ${count} authority grants (the HOW MUCH axis)`);
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

interface SeededOffering {
  id: string;
  offeringCode: string;
  name: string;
  vertical: string;
  priceBookEntryId: string | null;
  unitPrice: number;
  maxDiscountPct: number;
}

async function seedCatalog(): Promise<SeededOffering[]> {
  const tenantId = (await currentTenant()).id;

  const catalog: Array<{
    code: string; name: string; description: string; vertical: Vertical;
    deliveryModel: DeliveryModel; revenue: RevenueTreatment; price: number;
    frequency: string; maxDiscount: number; publish: boolean;
  }> = [
    { code: 'SAP-S4-IMPL', name: 'SAP S/4HANA Implementation', description: 'End-to-end S/4HANA migration and rollout.', vertical: 'sap_enterprise', deliveryModel: 'professional_services', revenue: 'milestone_based', price: 8_500_000, frequency: 'milestone', maxDiscount: 12, publish: true },
    { code: 'SAP-SUPPORT', name: 'SAP Managed Support (AMS)', description: 'Ongoing application management services.', vertical: 'sap_enterprise', deliveryModel: 'saas_subscription', revenue: 'over_time_ratable', price: 450_000, frequency: 'monthly', maxDiscount: 15, publish: true },
    { code: 'CYBER-SOC', name: 'Managed SOC', description: '24x7 security operations centre.', vertical: 'cybersecurity', deliveryModel: 'saas_subscription', revenue: 'over_time_ratable', price: 650_000, frequency: 'monthly', maxDiscount: 10, publish: true },
    { code: 'CYBER-VAPT', name: 'VAPT Engagement', description: 'Vulnerability assessment and penetration testing.', vertical: 'cybersecurity', deliveryModel: 'professional_services', revenue: 'point_in_time', price: 1_200_000, frequency: 'one_time', maxDiscount: 20, publish: true },
    { code: 'AI-PLATFORM', name: 'AI Platform Build', description: 'Custom AI platform design and delivery.', vertical: 'software_ai', deliveryModel: 'professional_services', revenue: 'milestone_based', price: 6_000_000, frequency: 'milestone', maxDiscount: 15, publish: true },
    { code: 'CT-LEADERSHIP', name: 'Leadership Development Programme', description: 'Cohort-based corporate leadership training.', vertical: 'corporate_training', deliveryModel: 'cohort', revenue: 'over_time_ratable', price: 1_800_000, frequency: 'one_time', maxDiscount: 25, publish: true },
    { code: 'EDU-FSD', name: 'Full Stack Development Programme', description: '24-week full stack cohort with placement support.', vertical: 'education', deliveryModel: 'cohort', revenue: 'over_time_ratable', price: 60_000, frequency: 'one_time', maxDiscount: 30, publish: true },
    { code: 'EDU-DS', name: 'Data Science Programme', description: '20-week data science cohort.', vertical: 'education', deliveryModel: 'cohort', revenue: 'over_time_ratable', price: 75_000, frequency: 'one_time', maxDiscount: 30, publish: true },
    { code: 'PLC-FEE', name: 'Placement Success Fee', description: 'Fee on confirmed placement.', vertical: 'placement', deliveryModel: 'placement_fee', revenue: 'point_in_time', price: 45_000, frequency: 'one_time', maxDiscount: 20, publish: true },
    // Deliberately published with no price book entry, so DET-CRM-OFF-01 has a
    // real coverage gap to detect on first run.
    { code: 'RES-ADVISORY', name: 'Applied Research Advisory', description: 'Advisory retainer for applied research programmes.', vertical: 'research', deliveryModel: 'professional_services', revenue: 'over_time_ratable', price: 0, frequency: 'monthly', maxDiscount: 0, publish: false },
  ];

  const out: SeededOffering[] = [];

  for (const c of catalog) {
    let offering = await prisma.offering.findFirst({ where: { tenantId, offeringCode: c.code } });
    if (!offering) {
      offering = await prisma.offering.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('OFF'),
          offeringCode: c.code,
          name: c.name,
          description: c.description,
          vertical: c.vertical,
          deliveryModel: c.deliveryModel,
          defaultRevenueTreatment: c.revenue,
          status: 'active',
          owningBusinessUnit: 'commercial',
        },
      });
    }

    let entry = await prisma.priceBookEntry.findFirst({ where: { tenantId, offeringId: offering.id, status: 'active' } });
    if (!entry && c.publish) {
      entry = await prisma.priceBookEntry.create({
        data: {
          tenantId,
          offeringId: offering.id,
          priceBookId: 'standard',
          priceBookName: 'Standard List',
          currency: 'INR',
          unitPrice: c.price,
          billingFrequency: c.frequency,
          minQuantity: 1,
          maxDiscountPct: c.maxDiscount,
          status: 'active',
          version: 1,
        },
      });
    }

    out.push({
      id: offering.id,
      offeringCode: c.code,
      name: c.name,
      vertical: c.vertical,
      priceBookEntryId: entry?.id ?? null,
      unitPrice: c.price,
      maxDiscountPct: c.maxDiscount,
    });
  }

  console.log(`  ${out.length} offerings (one deliberately unpriced, so the coverage detector has something real to find)`);
  return out;
}

async function seedTerritoriesAndRouting(people: SeededPerson[]) {
  const tenantId = (await currentTenant()).id;

  const territories = [
    { name: 'Chennai Metro — Enterprise', districts: ['Chennai', 'Kanchipuram'], verticals: ['sap_enterprise', 'cybersecurity', 'software_ai', 'corporate_training'], kind: 'organization', owner: 'bhead@kaizen.co.in', capacity: 40 },
    { name: 'Western TN — Enterprise', districts: ['Coimbatore', 'Erode', 'Salem'], verticals: ['sap_enterprise', 'cybersecurity', 'software_ai'], kind: 'organization', owner: 'director@kaizen.co.in', capacity: 35 },
    { name: 'Southern TN — Institutions', districts: ['Madurai', 'Tirunelveli', 'Dindigul', 'Thanjavur'], verticals: ['partnerships', 'education'], kind: 'institution', owner: 'bhead@kaizen.co.in', capacity: 60 },
    { name: 'State-wide — Placement', districts: [], verticals: ['placement'], kind: 'any', owner: 'director@kaizen.co.in', capacity: 50 },
  ];

  for (const t of territories) {
    const exists = await prisma.territory.findFirst({ where: { tenantId, name: t.name } });
    if (exists) continue;
    const owner = people.find((p) => p.email === t.owner);
    await prisma.territory.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('TER'),
        name: t.name,
        // The hard-coded district constant becomes seed data for a territory
        // row, not a platform-wide constant.
        geoAreaRef: t.districts,
        appliesToVerticals: t.verticals,
        appliesToAccountKind: t.kind,
        ownerPartyId: owner?.id ?? null,
        ownerPositionId: owner ? `pos_${owner.roleSlug}` : null,
        capacityCeiling: t.capacity,
      },
    });
  }

  const ruleExists = await prisma.routingRule.findFirst({ where: { tenantId } });
  if (!ruleExists) {
    await prisma.routingRule.create({
      data: {
        tenantId,
        name: 'Default six-factor routing',
        active: true,
        priority: 100,
        // Relationship strength is weighted equal to capacity deliberately: in
        // the institution motion, a warm existing contact beats an empty diary.
        factorWeights: { capacity: 30, capability: 25, relationship_strength: 30, round_robin: 15 },
        tieBreakMarginPoints: 5,
      },
    });
  }

  console.log(`  ${territories.length} territories and the six-factor routing rule`);
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

interface SeededOrg {
  id: string;
  name: string;
  hasAccount: boolean;
  hasInstitution: boolean;
  district: string;
}

async function seedOrganizations(): Promise<SeededOrg[]> {
  const tenantId = (await currentTenant()).id;

  const orgs: Array<{
    name: string; website: string; account?: { tier: string; terms: number };
    institution?: { type: string; management: string; district: string; students: number; aishe: string | null };
    district: string;
  }> = [
    { name: 'Sundaram Textiles Ltd', website: 'https://sundaramtextiles.example', account: { tier: 'strategic', terms: 45 }, district: 'Coimbatore' },
    { name: 'Meridian Financial Services', website: 'https://meridianfs.example', account: { tier: 'key', terms: 30 }, district: 'Chennai' },
    { name: 'Cauvery Logistics', website: 'https://cauverylogistics.example', account: { tier: 'standard', terms: 30 }, district: 'Tiruchirappalli' },
    { name: 'Nexa Healthcare Systems', website: 'https://nexahealth.example', account: { tier: 'key', terms: 60 }, district: 'Chennai' },
    { name: 'Vaigai Power Solutions', website: 'https://vaigaipower.example', account: { tier: 'standard', terms: 30 }, district: 'Madurai' },
    {
      // The commissioning example: a single legal body that is simultaneously
      // an admissions-partner institution AND a fee-paying corporate training
      // client. The legacy exclusive category enum could not represent this.
      name: 'Anna Institute of Technology',
      website: 'https://ait.example',
      account: { tier: 'key', terms: 45 },
      institution: { type: 'engineering_college', management: 'self_financing', district: 'Chennai', students: 4200, aishe: 'C-12345' },
      district: 'Chennai',
    },
    { name: 'Madurai Kamaraj Arts College', website: 'https://mkac.example', institution: { type: 'arts_science_college', management: 'aided', district: 'Madurai', students: 2800, aishe: 'C-23451' }, district: 'Madurai' },
    { name: 'Government Polytechnic Salem', website: 'https://gpsalem.example', institution: { type: 'polytechnic', management: 'government', district: 'Salem', students: 1400, aishe: null }, district: 'Salem' },
    { name: 'Thanjavur Engineering College', website: 'https://tec.example', institution: { type: 'engineering_college', management: 'self_financing', district: 'Thanjavur', students: 3100, aishe: 'C-34512' }, district: 'Thanjavur' },
    { name: 'Vellore Science Academy', website: 'https://vsa.example', institution: { type: 'arts_science_college', management: 'private', district: 'Vellore', students: 1900, aishe: 'C-45123' }, district: 'Vellore' },
    { name: 'TalentBridge Staffing', website: 'https://talentbridge.example', account: { tier: 'standard', terms: 30 }, district: 'Coimbatore' },
    { name: 'Zenith Manufacturing', website: 'https://zenithmfg.example', account: { tier: 'key', terms: 45 }, district: 'Erode' },
  ];

  const out: SeededOrg[] = [];

  for (const o of orgs) {
    let org = await prisma.organization.findFirst({ where: { tenantId, name: o.name } });
    if (!org) {
      org = await prisma.organization.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('ORG'),
          name: o.name,
          website: o.website,
          tags: [],
          // Retained transitionally for backward-compatible reporting only.
          legacyCategory: o.institution ? 'institution' : 'company',
        },
      });
    }

    if (o.account) {
      const exists = await prisma.account.findFirst({ where: { organizationId: org.id } });
      if (!exists) {
        await prisma.account.create({
          data: {
            tenantId,
            organizationId: org.id,
            tier: o.account.tier,
            paymentTermsDays: o.account.terms,
            billingEmail: `accounts@${o.website.replace('https://', '')}`,
          },
        });
      }
    }

    if (o.institution) {
      const exists = await prisma.institutionProfile.findFirst({ where: { organizationId: org.id } });
      if (!exists) {
        await prisma.institutionProfile.create({
          data: {
            tenantId,
            organizationId: org.id,
            institutionType: o.institution.type,
            managementType: o.institution.management,
            district: o.institution.district,
            state: 'Tamil Nadu',
            studentCount: o.institution.students,
            // Never fabricated: the government polytechnic legitimately has no
            // recorded identifier, so it is left null.
            externalIdentifier: o.institution.aishe,
            establishedYear: 1985 + (o.institution.students % 30),
            departments: ['Computer Science', 'Electronics', 'Mechanical'],
            strategicPriority: o.institution.students > 3000 ? 'high' : 'medium',
          },
        });
      }
    }

    out.push({ id: org.id, name: o.name, hasAccount: Boolean(o.account), hasInstitution: Boolean(o.institution), district: o.district });
  }

  console.log(`  ${out.length} organizations (one carries both specialisations simultaneously)`);
  return out;
}

// ---------------------------------------------------------------------------
// The commercial dataset
// ---------------------------------------------------------------------------

async function seedCommercialDataset(people: SeededPerson[], orgs: SeededOrg[], catalog: SeededOffering[]) {
  const tenantId = (await currentTenant()).id;

  const existingLeads = await prisma.lead.count({ where: { tenantId } });
  if (existingLeads > 0) {
    console.log('  commercial dataset already present — skipping');
    return;
  }

  const sales = people.filter((p) => p.roleSlug === 'sales');
  const counsellor = people.find((p) => p.roleSlug === 'education_counsellor')!;
  const placement = people.find((p) => p.roleSlug === 'workforce_placement')!;
  const telecaller = people.find((p) => p.roleSlug === 'telecaller')!;

  const pipelines = await prisma.pipelineDefinition.findMany({
    where: { tenantId },
    include: { stages: { where: { retiredAt: null, postAward: false }, orderBy: { sequence: 'asc' } } },
  });
  const byCode = new Map(pipelines.map((p) => [p.pipelineCode, p]));

  const accountOrgs = orgs.filter((o) => o.hasAccount);
  const institutionOrgs = orgs.filter((o) => o.hasInstitution);

  // ---- Contact people ------------------------------------------------------
  const contacts: Array<{ id: string; name: string; orgId: string }> = [];
  const contactNames = [
    'Hariharan Muthu', 'Deepa Varma', 'Karthik Raman', 'Sneha Pillai', 'Vignesh Anand',
    'Anjali Menon', 'Prakash Naidu', 'Revathi Iyer', 'Manoj Gupta', 'Shalini Rao',
    'Balaji Narayanan', 'Ritu Sharma',
  ];
  for (const [i, name] of contactNames.entries()) {
    const org = pick(orgs, i);
    const phone = `98${String(41000000 + i * 137).padStart(8, '0')}`;
    const person = await prisma.person.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('PER'),
        fullName: name,
        primaryPhone: phone,
        primaryPhoneNormalised: phone,
        primaryEmail: `${name.split(' ')[0].toLowerCase()}@${org.name.split(' ')[0].toLowerCase()}.example`,
        primaryEmailNormalised: `${name.split(' ')[0].toLowerCase()}@${org.name.split(' ')[0].toLowerCase()}.example`,
        source: 'seed',
      },
    });
    await prisma.affiliation.create({
      data: {
        tenantId,
        partyId: person.id,
        affiliationType: org.hasInstitution && !org.hasAccount ? 'institution_contact' : 'customer_contact',
        counterpartyId: org.id,
        counterpartyName: org.name,
        primaryFlag: true,
      },
    });
    await prisma.relationship.create({
      data: {
        tenantId,
        fromType: 'person',
        fromId: person.id,
        toType: 'organization',
        toId: org.id,
        relationshipType: i % 3 === 0 ? 'decision_maker_for' : 'employed_by',
        role: i % 3 === 0 ? 'Decision Maker' : 'Programme Contact',
        status: 'active',
        strength: i % 4 === 0 ? 'strong' : i % 2 === 0 ? 'moderate' : 'weak',
        ownerPartyId: pick(sales, i).id,
      },
    });
    contacts.push({ id: person.id, name, orgId: org.id });
  }

  // ---- Leads across every motion ------------------------------------------
  const leadSpecs: Array<{ title: string; vertical: Vertical; pipeline: string; orgIdx: number; owner: string | null; stageIdx: number; value: number; source: string; ageDays: number }> = [
    { title: 'S/4HANA migration assessment', vertical: 'sap_enterprise', pipeline: 'PL-ENTERPRISE', orgIdx: 0, owner: sales[0].id, stageIdx: 1, value: 8_500_000, source: 'referral', ageDays: 12 },
    { title: 'SOC evaluation for core banking', vertical: 'cybersecurity', pipeline: 'PL-ENTERPRISE', orgIdx: 1, owner: sales[1].id, stageIdx: 2, value: 7_800_000, source: 'inbound_website', ageDays: 21 },
    { title: 'Fleet telemetry AI pilot', vertical: 'software_ai', pipeline: 'PL-ENTERPRISE', orgIdx: 2, owner: sales[0].id, stageIdx: 0, value: 3_200_000, source: 'event', ageDays: 4 },
    { title: 'Clinical analytics platform', vertical: 'software_ai', pipeline: 'PL-ENTERPRISE', orgIdx: 3, owner: sales[1].id, stageIdx: 3, value: 6_000_000, source: 'referral', ageDays: 30 },
    // Deliberately unrouted at seed, so the unrouted queue and EX-CRM-004 have
    // a real case on first load.
    { title: 'Grid resilience advisory enquiry', vertical: 'research', pipeline: 'PL-ENTERPRISE', orgIdx: 4, owner: null, stageIdx: 0, value: 1_500_000, source: 'inbound_website', ageDays: 6 },
    { title: 'MoU for placement partnership', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 6, owner: counsellor.id, stageIdx: 1, value: 0, source: 'campaign', ageDays: 45 },
    { title: 'Campus programme partnership', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 8, owner: counsellor.id, stageIdx: 2, value: 0, source: 'referral', ageDays: 18 },
    { title: 'Full stack admission — Chennai batch', vertical: 'education', pipeline: 'PL-ADMISSION', orgIdx: 5, owner: counsellor.id, stageIdx: 1, value: 60_000, source: 'inbound_website', ageDays: 2 },
    { title: 'Data science admission enquiry', vertical: 'education', pipeline: 'PL-ADMISSION', orgIdx: 9, owner: telecaller.id, stageIdx: 0, value: 75_000, source: 'campaign', ageDays: 7 },
    { title: 'Bulk hiring — 40 developers', vertical: 'placement', pipeline: 'PL-PLACEMENT', orgIdx: 10, owner: placement.id, stageIdx: 2, value: 1_800_000, source: 'referral', ageDays: 14 },
    { title: 'Manufacturing graduate intake', vertical: 'placement', pipeline: 'PL-PLACEMENT', orgIdx: 11, owner: placement.id, stageIdx: 1, value: 900_000, source: 'event', ageDays: 25 },
    { title: 'Leadership programme for senior managers', vertical: 'corporate_training', pipeline: 'PL-ENTERPRISE', orgIdx: 11, owner: sales[0].id, stageIdx: 1, value: 1_800_000, source: 'campaign', ageDays: 9 },
  ];

  for (const [i, spec] of leadSpecs.entries()) {
    const pipeline = byCode.get(spec.pipeline)!;
    const stage = pipeline.stages[spec.stageIdx] ?? pipeline.stages[0];
    const org = orgs[spec.orgIdx];
    const contact = contacts.find((c) => c.orgId === org.id) ?? contacts[i % contacts.length];
    const offering = catalog.find((c) => c.vertical === spec.vertical) ?? catalog[0];
    const stageEnteredAt = new Date(Date.now() - spec.ageDays * 86_400_000);

    const lead = await prisma.lead.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('LEAD'),
        title: spec.title,
        personId: contact.id,
        organizationId: org.id,
        vertical: spec.vertical,
        offeringId: offering.id,
        pipelineId: pipeline.id,
        stageKey: stage.stageKey,
        stageEnteredAt,
        leadStatus: 'open',
        ownerPartyId: spec.owner,
        unroutedReason: spec.owner ? null : 'no_vertical_coverage',
        routedAt: spec.owner ? stageEnteredAt : null,
        score: 40 + ((i * 7) % 55),
        scoreReasons: ['+15 reachable by phone', '+20 linked to a known organization', `+${8 + (i % 12)} source: ${spec.source}`],
        source: spec.source,
        estimatedValue: spec.value || undefined,
        currency: 'INR',
        lastInteractionAt: i % 4 === 0 ? null : new Date(Date.now() - (spec.ageDays - 1) * 86_400_000),
        createdAt: stageEnteredAt,
      },
    });

    // Interactions, so timelines and the untouched detector have real inputs.
    if (i % 4 !== 0) {
      await prisma.interaction.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('INT'),
          interactionType: pick(['call', 'email', 'meeting', 'whatsapp'], i),
          direction: i % 2 === 0 ? 'outbound' : 'inbound',
          occurredAt: new Date(Date.now() - (spec.ageDays - 1) * 86_400_000),
          actorPartyId: spec.owner ?? telecaller.id,
          participantPartyIds: [contact.id],
          durationMinutes: 15 + ((i * 5) % 40),
          subject: `Discovery on ${spec.title}`,
          notes: 'Discussed scope, timeline and the internal approval path.',
          outcome: pick(['connected', 'meeting_scheduled', 'information_shared', 'follow_up_required'], i),
          relatedReferences: [
            { contextCode: 'crm', entityType: 'lead', entityId: lead.id, displayLabel: lead.title, recordCode: lead.recordCode },
            { contextCode: 'idn', entityType: 'person', entityId: contact.id, displayLabel: contact.name },
          ] as never,
          sensitivityClass: 'internal',
        },
      });
    }
  }

  // ---- Opportunities -------------------------------------------------------
  const oppSpecs: Array<{
    title: string; vertical: Vertical; pipeline: string; orgIdx: number; owner: string;
    stageIdx: number; value: number; forecast: string; ageDays: number; closeInDays: number;
    strategic: string | null; outcome?: string;
  }> = [
    { title: 'Sundaram — S/4HANA implementation', vertical: 'sap_enterprise', pipeline: 'PL-ENTERPRISE', orgIdx: 0, owner: sales[0].id, stageIdx: 5, value: 9_200_000, forecast: 'commit', ageDays: 11, closeInDays: 25, strategic: 'high' },
    { title: 'Meridian — managed SOC rollout', vertical: 'cybersecurity', pipeline: 'PL-ENTERPRISE', orgIdx: 1, owner: sales[1].id, stageIdx: 4, value: 7_800_000, forecast: 'best_case', ageDays: 26, closeInDays: 45, strategic: 'high' },
    { title: 'Nexa — clinical analytics platform', vertical: 'software_ai', pipeline: 'PL-ENTERPRISE', orgIdx: 3, owner: sales[1].id, stageIdx: 3, value: 6_000_000, forecast: 'pipeline', ageDays: 34, closeInDays: 70, strategic: 'medium' },
    { title: 'Cauvery — fleet telemetry AI', vertical: 'software_ai', pipeline: 'PL-ENTERPRISE', orgIdx: 2, owner: sales[0].id, stageIdx: 2, value: 3_200_000, forecast: 'pipeline', ageDays: 8, closeInDays: 90, strategic: 'low' },
    { title: 'Zenith — leadership programme', vertical: 'corporate_training', pipeline: 'PL-ENTERPRISE', orgIdx: 11, owner: sales[0].id, stageIdx: 4, value: 1_900_000, forecast: 'best_case', ageDays: 15, closeInDays: 30, strategic: 'medium' },
    // Deliberately stale: expected close date in the past while sitting in
    // commit, so AU-CRM-010 has a real demotion to make on the first job run.
    { title: 'Vaigai — VAPT engagement', vertical: 'cybersecurity', pipeline: 'PL-ENTERPRISE', orgIdx: 4, owner: sales[1].id, stageIdx: 5, value: 1_250_000, forecast: 'commit', ageDays: 40, closeInDays: -8, strategic: 'medium' },
    { title: 'Anna Institute — campus MoU', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 5, owner: counsellor.id, stageIdx: 4, value: 0, forecast: 'best_case', ageDays: 22, closeInDays: 40, strategic: 'high' },
    { title: 'Madurai Kamaraj — placement MoU', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 6, owner: counsellor.id, stageIdx: 3, value: 0, forecast: 'pipeline', ageDays: 48, closeInDays: 60, strategic: 'high' },
    { title: 'TalentBridge — 40 developer intake', vertical: 'placement', pipeline: 'PL-PLACEMENT', orgIdx: 10, owner: placement.id, stageIdx: 4, value: 1_800_000, forecast: 'commit', ageDays: 12, closeInDays: 20, strategic: 'medium' },
    { title: 'Zenith — graduate intake 2026', vertical: 'placement', pipeline: 'PL-PLACEMENT', orgIdx: 11, owner: placement.id, stageIdx: 2, value: 900_000, forecast: 'pipeline', ageDays: 27, closeInDays: 75, strategic: 'low' },
    { title: 'Thanjavur Engineering — cohort partnership', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 8, owner: counsellor.id, stageIdx: 1, value: 0, forecast: 'pipeline', ageDays: 55, closeInDays: 120, strategic: 'medium' },
    { title: 'Vellore Science — admissions channel', vertical: 'partnerships', pipeline: 'PL-INSTITUTION', orgIdx: 9, owner: counsellor.id, stageIdx: 2, value: 0, forecast: 'pipeline', ageDays: 19, closeInDays: 95, strategic: 'low' },
  ];

  const createdOpps: Array<{ id: string; recordCode: string; title: string; orgId: string; value: number; owner: string; strategic: string | null }> = [];

  for (const [i, spec] of oppSpecs.entries()) {
    const pipeline = byCode.get(spec.pipeline)!;
    const stage = pipeline.stages[spec.stageIdx] ?? pipeline.stages[0];
    const org = orgs[spec.orgIdx];
    const contact = contacts.find((c) => c.orgId === org.id) ?? contacts[i % contacts.length];
    const offering = catalog.find((c) => c.vertical === spec.vertical) ?? catalog[0];
    const stageEnteredAt = new Date(Date.now() - spec.ageDays * 86_400_000);

    const opp = await prisma.opportunity.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('OPP'),
        title: spec.title,
        organizationId: org.id,
        primaryContactPersonId: contact.id,
        vertical: spec.vertical,
        offeringId: offering.id,
        pipelineId: pipeline.id,
        stageKey: stage.stageKey,
        stageEnteredAt,
        forecastCategory: spec.forecast,
        forecastCategoryChangedAt: stageEnteredAt,
        expectedValue: spec.value || undefined,
        currency: 'INR',
        expectedCloseDate: daysFromNow(spec.closeInDays),
        ownerPartyId: spec.owner,
        strategicValue: spec.strategic,
        createdAt: stageEnteredAt,
      },
    });

    createdOpps.push({ id: opp.id, recordCode: opp.recordCode, title: opp.title, orgId: org.id, value: spec.value, owner: spec.owner, strategic: spec.strategic });

    await prisma.interaction.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('INT'),
        interactionType: pick(['meeting', 'call', 'demo'], i),
        direction: 'outbound',
        occurredAt: new Date(Date.now() - Math.max(spec.ageDays - 3, 1) * 86_400_000),
        actorPartyId: spec.owner,
        participantPartyIds: [contact.id],
        durationMinutes: 45,
        subject: `Solution review — ${spec.title}`,
        notes: 'Walked the proposed architecture and commercial shape. Committee review scheduled.',
        outcome: 'meeting_scheduled',
        relatedReferences: [
          { contextCode: 'crm', entityType: 'opportunity', entityId: opp.id, displayLabel: opp.title, recordCode: opp.recordCode },
          { contextCode: 'crm', entityType: 'organization', entityId: org.id, displayLabel: org.name },
        ] as never,
        sensitivityClass: 'internal',
      },
    });
  }

  // ---- Won deals, with the award artefact that satisfies the gate ----------
  const wonSpecs = [
    { title: 'Sundaram — AMS renewal FY25', orgIdx: 0, owner: sales[0].id, value: 5_400_000, closedDaysAgo: 40 },
    { title: 'Meridian — VAPT engagement 2025', orgIdx: 1, owner: sales[1].id, value: 1_200_000, closedDaysAgo: 75 },
    { title: 'Nexa — AI readiness assessment', orgIdx: 3, owner: sales[0].id, value: 850_000, closedDaysAgo: 20 },
  ];

  const enterprise = byCode.get('PL-ENTERPRISE')!;
  const wonStage = enterprise.stages.find((s) => s.pipelinePosition === 90)!;

  for (const [i, w] of wonSpecs.entries()) {
    const org = orgs[w.orgIdx];
    const closedAt = new Date(Date.now() - w.closedDaysAgo * 86_400_000);

    const opp = await prisma.opportunity.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('OPP'),
        title: w.title,
        organizationId: org.id,
        vertical: 'sap_enterprise',
        offeringId: catalog[0].id,
        pipelineId: enterprise.id,
        stageKey: wonStage.stageKey,
        stageEnteredAt: closedAt,
        forecastCategory: 'closed_won',
        expectedValue: w.value,
        currency: 'INR',
        expectedCloseDate: closedAt,
        ownerPartyId: w.owner,
        strategicValue: 'medium',
        outcome: 'won',
        closedAt,
        createdAt: new Date(closedAt.getTime() - 60 * 86_400_000),
      },
    });

    // The won-gate is satisfied by a real signed contract, not a document
    // reference — a document's existence proves nothing about signature.
    const contract = await prisma.contract.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('CON'),
        title: w.title,
        organizationId: org.id,
        opportunityId: opp.id,
        status: 'active',
        commercialValue: w.value,
        currency: 'INR',
        strategicValue: 'medium',
        termMonths: 12,
        startDate: closedAt,
        // The first contract expires inside the 120-day ladder, so the expiry
        // detector has a real rung to fire on.
        endDate: daysFromNow(i === 0 ? 85 : 300 + i * 40),
        signedDate: closedAt,
        ownerPartyId: w.owner,
      },
    });

    await prisma.opportunity.update({ where: { id: opp.id }, data: { contractId: contract.id } });

    const project = await prisma.project.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('PRJ'),
        name: w.title,
        organizationId: org.id,
        opportunityId: opp.id,
        contractId: contract.id,
        status: i === 0 ? 'active' : 'planned',
        startDate: closedAt,
        targetEndDate: daysFromNow(120),
        scheduleVariancePct: i * 8,
        healthBand: i === 2 ? 'watch' : 'stable',
        // The third project's handoff is deliberately unaccepted, so
        // EX-CRM-012 and the H_DLV handoff factor have something real.
        handoffAcceptedAt: i === 2 ? null : closedAt,
      },
    });

    // Money: the signed contract's invoice, with partial allocation, so the
    // receipt join has real work to do.
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('INV'),
        organizationId: org.id,
        contractId: contract.id,
        opportunityId: opp.id,
        status: 'issued',
        currency: 'INR',
        issuedDate: closedAt,
        dueDate: new Date(closedAt.getTime() + 30 * 86_400_000),
      },
    });
    await prisma.invoiceLine.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        offeringId: catalog[0].id,
        description: `${contract.recordCode} — ${w.title}`,
        amount: w.value,
        revenueMethod: 'milestone_based',
      },
    });

    if (i < 2) {
      const payment = await prisma.payment.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('PAY'),
          amount: i === 0 ? w.value : w.value * 0.4,
          currency: 'INR',
          gatewayReference: `TXN-${randomUUID().slice(0, 12).toUpperCase()}`,
          receivedAt: new Date(closedAt.getTime() + 12 * 86_400_000),
          status: 'received',
          method: 'bank_transfer',
          payerOrganizationId: org.id,
        },
      });
      await prisma.receipt.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('REC'),
          paymentId: payment.id,
          invoiceId: invoice.id,
          allocatedAmount: i === 0 ? w.value : w.value * 0.4,
        },
      });
      await prisma.invoice.update({ where: { id: invoice.id }, data: { status: i === 0 ? 'settled' : 'part_paid' } });
    }

    await prisma.receivablesProjection.upsert({
      where: { tenantId_subjectType_subjectId: { tenantId, subjectType: 'account', subjectId: org.id } },
      create: {
        tenantId,
        subjectType: 'account',
        subjectId: org.id,
        subjectLabel: org.name,
        amountOutstanding: i === 0 ? 0 : i === 1 ? w.value * 0.6 : w.value,
        currency: 'INR',
        nextDueDate: new Date(closedAt.getTime() + 30 * 86_400_000),
        dunningStage: i === 2 ? 'chase' : i === 1 ? 'reminder' : null,
      },
      update: {},
    });
  }

  // ---- Lost deals with structured post-mortems -----------------------------
  const lostStage = enterprise.stages.find((s) => s.pipelinePosition === 0)!;
  const lostSpecs = [
    { title: 'Cauvery — ERP consolidation', orgIdx: 2, owner: sales[0].id, value: 4_200_000, reason: 'competitor', competitor: 'Larsen Digital', strategic: 'high', complete: true },
    { title: 'Vaigai — cyber posture review', orgIdx: 4, owner: sales[1].id, value: 620_000, reason: 'no_budget', competitor: null, strategic: 'low', complete: false },
  ];

  for (const l of lostSpecs) {
    const org = orgs[l.orgIdx];
    const closedAt = new Date(Date.now() - 30 * 86_400_000);
    const opp = await prisma.opportunity.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('OPP'),
        title: l.title,
        organizationId: org.id,
        vertical: 'sap_enterprise',
        offeringId: catalog[0].id,
        pipelineId: enterprise.id,
        stageKey: lostStage.stageKey,
        stageEnteredAt: closedAt,
        forecastCategory: 'closed_lost',
        expectedValue: l.value,
        currency: 'INR',
        ownerPartyId: l.owner,
        strategicValue: l.strategic,
        outcome: 'lost',
        lostReason: l.reason,
        closedAt,
        createdAt: new Date(closedAt.getTime() - 90 * 86_400_000),
      },
    });

    // The OR gate, computed once at terminal-state entry and frozen.
    const mandatory = l.strategic === 'high' || l.value >= 500_000;
    await prisma.winLossReview.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('WLR'),
        subjectType: 'opportunity',
        subjectId: opp.id,
        subjectLabel: `${opp.recordCode} — ${opp.title}`,
        outcome: 'lost',
        competitorName: l.complete ? l.competitor : null,
        realLostStage: l.complete ? 'solution_shaped' : null,
        lostReason: l.reason,
        lesson: l.complete ? 'We were shaped out at architecture review because the incumbent already held the integration layer. Qualify integration ownership at the qualified stage, not at proposal.' : null,
        mandatory,
        mandatoryBasis: mandatory
          ? [l.strategic === 'high' ? 'strategic_value=high' : null, l.value >= 500_000 ? 'commercial_value>=500000' : null].filter(Boolean).join(' OR ')
          : 'not_mandatory',
        strategicValueSnapshot: l.strategic,
        commercialValueSnapshot: l.value,
        thresholdUsedSnapshot: 500_000,
        completedAt: l.complete ? new Date(closedAt.getTime() + 5 * 86_400_000) : null,
        completedById: l.complete ? l.owner : null,
        // The incomplete one is past its grace period, so the overdue detector
        // has a real case.
        dueAt: mandatory ? new Date(closedAt.getTime() + 10 * 86_400_000) : null,
      },
    });

    if (l.complete) {
      await prisma.lesson.create({
        data: {
          tenantId,
          sourceType: 'win_loss_review',
          sourceId: opp.id,
          title: `Lost: ${opp.title}`,
          body: 'Qualify integration ownership at the qualified stage, not at proposal. An incumbent holding the integration layer shapes the architecture review before we arrive.',
          domain: 'crm',
          tags: ['lost', 'competitor', 'sap_enterprise'],
        },
      });
    }
  }

  // ---- MoUs, including one inside the expiry ladder ------------------------
  const mouSpecs = [
    { title: 'Anna Institute — campus partnership MoU', orgIdx: 5, status: 'active', value: 0, strategic: 'high', endInDays: 25, owner: counsellor.id },
    { title: 'Madurai Kamaraj — placement MoU', orgIdx: 6, status: 'signed', value: 250_000, strategic: 'medium', endInDays: 200, owner: counsellor.id },
    { title: 'Government Polytechnic Salem — skills MoU', orgIdx: 7, status: 'negotiating', value: 0, strategic: 'high', endInDays: 365, owner: counsellor.id },
    { title: 'Vellore Science — admissions channel MoU', orgIdx: 9, status: 'proposed', value: 1_500_000, strategic: 'high', endInDays: 400, owner: counsellor.id },
  ];

  for (const m of mouSpecs) {
    const org = orgs[m.orgIdx];
    await prisma.mou.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('MOU'),
        // The pre-migration three-digit value, preserved verbatim.
        legacyReference: `KAIZEN-2024-${String(101 + m.orgIdx).padStart(3, '0')}`,
        title: m.title,
        organizationId: org.id,
        institutionId: org.hasInstitution ? org.id : null,
        scope: 'Placement support, campus programmes and joint certification.',
        vertical: 'partnerships',
        status: m.status,
        commercialValue: m.value,
        currency: 'INR',
        strategicValue: m.strategic,
        termMonths: 24,
        startDate: daysFromNow(-200),
        endDate: daysFromNow(m.endInDays),
        signedDate: ['signed', 'active'].includes(m.status) ? daysFromNow(-195) : null,
        ownerPartyId: m.owner,
      },
    });
  }

  // ---- Partner agreements --------------------------------------------------
  const partnerOrg = orgs[10];
  const rel = await prisma.relationship.create({
    data: {
      tenantId,
      fromType: 'organization',
      fromId: 'kaizen',
      toType: 'organization',
      toId: partnerOrg.id,
      relationshipType: 'partner_of',
      role: 'placement_channel',
      status: 'active',
      strength: 'strong',
      ownerPartyId: placement.id,
    },
  });
  await prisma.partnerAgreement.create({
    data: {
      tenantId,
      recordCode: await nextRecordCode('PA'),
      title: 'TalentBridge — placement channel agreement',
      partnerOrganizationId: partnerOrg.id,
      relationshipId: rel.id,
      agreementType: 'placement_channel',
      scope: 'Candidate sourcing and placement fulfilment across Tamil Nadu.',
      territoryScope: 'Tamil Nadu',
      status: 'active',
      commercialValue: 2_400_000,
      currency: 'INR',
      strategicValue: 'medium',
      termMonths: 12,
      startDate: daysFromNow(-120),
      endDate: daysFromNow(245),
      signedDate: daysFromNow(-118),
      ownerPartyId: placement.id,
    },
  });

  // ---- Proposals and quotes, including a blocked discount ------------------
  const proposalTargets = createdOpps.slice(0, 4);
  for (const [i, target] of proposalTargets.entries()) {
    const sentAt = new Date(Date.now() - (i === 0 ? 9 : 3 + i) * 86_400_000);
    const proposal = await prisma.proposal.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('PRO'),
        opportunityId: target.id,
        title: `Proposal — ${target.title}`,
        totalValue: target.value || 1_000_000,
        currency: 'INR',
        sentAt,
        validUntil: new Date(sentAt.getTime() + 30 * 86_400_000),
        response: 'pending',
        ownerPartyId: target.owner,
      },
    });
    await prisma.opportunity.update({
      where: { id: target.id },
      data: { proposalId: proposal.id, proposalSentAt: sentAt },
    });
  }

  const sapPrice = catalog.find((c) => c.offeringCode === 'SAP-S4-IMPL')!;
  const cyberPrice = catalog.find((c) => c.offeringCode === 'CYBER-SOC')!;

  if (sapPrice.priceBookEntryId && cyberPrice.priceBookEntryId) {
    // A within-ceiling quote, issued cleanly.
    const okQuote = await prisma.quote.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('QUO'),
        opportunityId: createdOpps[0].id,
        version: 1,
        status: 'issued',
        currency: 'INR',
        subtotal: sapPrice.unitPrice,
        discountTotal: sapPrice.unitPrice * 0.08,
        grandTotal: sapPrice.unitPrice * 0.92,
        issuedAt: daysFromNow(-6),
        validUntil: daysFromNow(24),
        ownerPartyId: createdOpps[0].owner,
      },
    });
    await prisma.quoteLine.create({
      data: {
        tenantId,
        quoteId: okQuote.id,
        priceBookEntryId: sapPrice.priceBookEntryId,
        priceBookEntryVersion: 1,
        quantity: 1,
        listUnitPrice: sapPrice.unitPrice,
        discountPct: 8,
        discountAmount: sapPrice.unitPrice * 0.08,
        lineTotal: sapPrice.unitPrice * 0.92,
      },
    });
    await prisma.opportunity.update({ where: { id: createdOpps[0].id }, data: { quoteId: okQuote.id } });

    // An over-ceiling quote: the WHOLE quote blocks, with an approval step
    // resolved onto the finance controller.
    const controller = people.find((p) => p.roleSlug === 'finance_controller')!;
    const blockedQuote = await prisma.quote.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('QUO'),
        opportunityId: createdOpps[1].id,
        version: 1,
        status: 'blocked',
        currency: 'INR',
        subtotal: cyberPrice.unitPrice * 12,
        discountTotal: cyberPrice.unitPrice * 12 * 0.22,
        grandTotal: cyberPrice.unitPrice * 12 * 0.78,
        blockedReason: `Managed SOC: 22% exceeds the ${cyberPrice.maxDiscountPct}% ceiling`,
        ownerPartyId: createdOpps[1].owner,
      },
    });
    await prisma.quoteLine.create({
      data: {
        tenantId,
        quoteId: blockedQuote.id,
        priceBookEntryId: cyberPrice.priceBookEntryId,
        priceBookEntryVersion: 1,
        quantity: 12,
        listUnitPrice: cyberPrice.unitPrice,
        discountPct: 22,
        discountAmount: cyberPrice.unitPrice * 12 * 0.22,
        lineTotal: cyberPrice.unitPrice * 12 * 0.78,
      },
    });
    const step = await prisma.approvalStep.create({
      data: {
        tenantId,
        subjectType: 'quote',
        subjectId: blockedQuote.id,
        subjectLabel: blockedQuote.recordCode,
        action: 'quote.issue',
        requestedById: createdOpps[1].owner,
        requestedValue: cyberPrice.unitPrice * 12 * 0.78,
        currency: 'INR',
        resolvedApproverId: controller.id,
        resolvedApproverRole: 'finance_controller',
        slaDueAt: daysFromNow(2),
      },
    });
    await prisma.quote.update({ where: { id: blockedQuote.id }, data: { approvalStepId: step.id } });
  }

  // ---- Open tasks ----------------------------------------------------------
  for (const [i, target] of createdOpps.slice(0, 6).entries()) {
    await prisma.task.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('TSK'),
        title: pick(['Send revised commercials', 'Confirm committee date', 'Chase signed NDA', 'Prepare architecture walkthrough'], i),
        assigneePartyId: target.owner,
        ownerPartyId: target.owner,
        dueAt: daysFromNow(i - 2),
        relatedType: 'opportunity',
        relatedId: target.id,
        status: 'open',
      },
    });
  }

  console.log(`  ${leadSpecs.length} leads, ${oppSpecs.length + wonSpecs.length + lostSpecs.length} opportunities, ${mouSpecs.length} MoUs, 3 contracts, quotes, invoices and tasks`);
}

// ---------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------

async function seedEducation(people: SeededPerson[], orgs: SeededOrg[]) {
  const tenantId = (await currentTenant()).id;
  const existing = await prisma.course.count({ where: { tenantId } });
  if (existing > 0) return;

  const trainer = people.find((p) => p.roleSlug === 'trainer')!;
  const institution = orgs.find((o) => o.hasInstitution)!;

  const courses = [
    { name: 'Full Stack Development', code: 'FSD-24', weeks: 24 },
    { name: 'Applied Data Science', code: 'ADS-20', weeks: 20 },
  ];

  const learnerNames = [
    'Aishwarya Ganesan', 'Bharath Kumar', 'Chitra Devi', 'Dinesh Raj', 'Elakkiya Murugan',
    'Farhan Ahmed', 'Gayathri Selvan', 'Harish Babu', 'Indira Natarajan', 'Jagan Mohan',
    'Kalaivani Rajan', 'Lokesh Prabhu',
  ];

  for (const [ci, c] of courses.entries()) {
    const course = await prisma.course.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('CRS'),
        name: c.name,
        code: c.code,
        description: `${c.weeks}-week cohort programme with placement support.`,
        durationWeeks: c.weeks,
      },
    });

    const cohort = await prisma.cohort.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('COH'),
        courseId: course.id,
        name: `${c.code} — Chennai ${2026 + ci}`,
        startDate: daysFromNow(-60 + ci * 20),
        endDate: daysFromNow(c.weeks * 7 - 60),
        trainerPartyId: trainer.id,
        institutionId: institution.id,
        capacity: 30,
        status: 'active',
      },
    });

    const slice = learnerNames.slice(ci * 6, ci * 6 + 6);
    for (const [li, name] of slice.entries()) {
      const phone = `97${String(31000000 + ci * 1000 + li * 17).padStart(8, '0')}`;
      const person = await prisma.person.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('PER'),
          fullName: name,
          primaryPhone: phone,
          primaryPhoneNormalised: phone,
          source: 'admissions',
        },
      });
      await prisma.affiliation.create({
        data: {
          tenantId,
          partyId: person.id,
          affiliationType: 'student',
          counterpartyName: cohort.name,
          counterpartyId: cohort.id,
          primaryFlag: true,
          // A student affiliation carries a statutory retention floor.
          statutoryRetentionFloor: true,
        },
      });

      const isMinor = li === 0;
      const attendance = li === 1 ? 58 : li === 4 ? 66 : 80 + ((li * 7) % 18);

      await prisma.enrollment.create({
        data: {
          tenantId,
          recordCode: await nextRecordCode('ENR'),
          legacyReference: `CERT-${c.code}-${li + 1}`,
          personId: person.id,
          cohortId: cohort.id,
          status: 'active',
          enrolledAt: daysFromNow(-55 + ci * 20),
          progressPct: 30 + ((li * 11) % 50),
          attendancePct: attendance,
          // Attendance below 70% flags risk, computed from records rather than
          // hand-maintained.
          atRisk: attendance < 70,
          isMinor,
          // Regulated (DPDP-covered) — read-audited, structurally excluded from
          // any projection whose viewer's ceiling does not clear it.
          guardianName: isMinor ? 'Ganesan Subramaniam' : null,
          guardianPhone: isMinor ? '9840777001' : null,
          guardianEmail: isMinor ? 'guardian@example.com' : null,
        },
      });
    }
  }

  console.log(`  ${courses.length} courses, 2 cohorts, 12 enrollments (one minor with regulated guardian contact)`);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * One open MERGE_CANDIDATE, raised the only way one can be: by putting a
 * genuine near-duplicate through `findOrCreatePerson` and letting the resolver
 * refuse it. Seeding the row directly would demonstrate the queue without
 * demonstrating the thing that fills it.
 *
 * The scenario is the ordinary one — the same human reaching the company twice,
 * once through a web enquiry and once through a phone call, with one identifier
 * shared and one differing. That partial match is exactly the case the resolver
 * is biased to refuse.
 */
async function seedMergeCandidate(_people: SeededPerson[]) {
  const shared = '9884412200';

  const first = await findOrCreatePerson({
    fullName: 'Ramesh Kumaravel',
    primaryPhone: shared,
    primaryEmail: 'ramesh.k@vaigaipower.example',
    source: 'web_enquiry',
  });

  try {
    // Same phone, different email: one identifier matches and one does not, so
    // this resolves to neither an existing person nor a new one.
    await findOrCreatePerson({
      fullName: 'R. Kumaravel',
      primaryPhone: shared,
      primaryEmail: 'rameshk@gmail.example',
      source: 'inbound_call',
    });
    console.log('  merge candidate  NOT raised — the resolver auto-merged, which it should not have');
  } catch {
    console.log(`  merge candidate  open, against ${first.person.recordCode} (partial match)`);
  }
}

async function seedDecisions(people: SeededPerson[]) {
  const tenantId = (await currentTenant()).id;
  const existing = await prisma.decision.count({ where: { tenantId } });
  if (existing > 0) return;

  const chairman = people.find((p) => p.roleSlug === 'chairman')!;
  const contract = await prisma.contract.findFirst({ where: { tenantId }, orderBy: { commercialValue: 'desc' } });
  const mou = await prisma.mou.findFirst({ where: { tenantId, strategicValue: 'high' } });

  if (contract) {
    await prisma.decision.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('DEC'),
        question: 'Should we extend payment terms to 90 days for Sundaram Textiles in exchange for a two-year AMS commitment?',
        state: 'AwaitingAuthority',
        subjectType: 'contract',
        subjectId: contract.id,
        subjectLabel: `${contract.recordCode} — ${contract.title}`,
        authorityBasis: 'contract_approval',
        requiredAuthorityValue: 5_400_000,
        currency: 'INR',
        routedToPartyId: chairman.id,
        routedToRole: 'chairman',
        evidenceComplete: true,
        // Seven components, assembled before routing.
        evidencePack: {
          question: 'Extend payment terms to 90 days in exchange for a two-year AMS commitment?',
          rejectedOptions: [
            { option: 'Hold at 45 days', outcome: 'Customer likely re-tenders at renewal', risk: 'Loses a strategic account', cost: 'Nil now, 5.4M at renewal' },
            { option: 'Extend to 60 days only', outcome: 'Partial concession, no commitment secured', risk: 'Concession without reciprocity', cost: 'Working capital, no upside' },
          ],
          noActionOption: { option: 'Take no action', consequence: 'Terms stay at 45 days and the AMS commitment lapses at renewal.', by: 'the renewal date' },
          subjectState: { status: contract.status, commercialValue: 5_400_000 },
          lastFiveTransitions: [],
          nearestPrecedents: [],
          constraintsAndGrant: { constraint: 'Requires contract_approval authority for 5,400,000 INR.', grantExercised: 'contract_approval ceiling 100,000,000' },
          modelView: { label: 'Model view', statement: 'Working capital impact of ~₹6.6L over the extended window, against a two-year commitment worth ₹1.08 Cr.', isModel: true },
          noActionConsequence: { statement: 'Terms stay at 45 days and the AMS commitment lapses at renewal.', by: 'the renewal date' },
          complete: true,
          missingComponents: [],
        } as never,
        pointOfNoReturn: daysFromNow(21),
        slaDueAt: daysFromNow(3),
        raisedAt: daysFromNow(-2),
      },
    });
  }

  if (mou) {
    // Deliberately incomplete: renders `Analysing` with a visible clock rather
    // than presenting as decidable.
    await prisma.decision.create({
      data: {
        tenantId,
        recordCode: await nextRecordCode('DEC'),
        question: 'Should the Anna Institute partnership be widened to include a joint certification track?',
        state: 'Analysing',
        subjectType: 'mou',
        subjectId: mou.id,
        subjectLabel: `${mou.recordCode} — ${mou.title}`,
        authorityBasis: 'mou_approval',
        currency: 'INR',
        routedToPartyId: chairman.id,
        routedToRole: 'chairman',
        evidenceComplete: false,
        evidencePack: {
          question: 'Widen the Anna Institute partnership to a joint certification track?',
          rejectedOptions: [],
          noActionOption: { option: 'Take no action', consequence: 'The partnership continues on placement support alone.', by: 'the MoU end date' },
          subjectState: { status: mou.status },
          lastFiveTransitions: [],
          nearestPrecedents: [],
          constraintsAndGrant: { constraint: 'Requires mou_approval authority.', grantExercised: 'mou_approval ceiling 100,000,000' },
          modelView: null,
          noActionConsequence: { statement: 'The partnership continues on placement support alone.', by: 'the MoU end date' },
          complete: false,
          missingComponents: ['question_and_rejected_options', 'three_nearest_precedents'],
        } as never,
        slaDueAt: daysFromNow(5),
        raisedAt: daysFromNow(-1),
      },
    });
  }

  console.log('  2 decisions (one decidable, one Analysing with an incomplete evidence pack)');
}
// ---------------------------------------------------------------------------

/**
 * Bootstrap the tenant, then fill it with the demonstration.
 *
 * Idempotent, like everything it calls: `scripts/test-db.sh` runs it against a
 * database that may already hold a previous run's mutations.
 */
export async function seedDemoDataset(): Promise<string> {
  const { tenantId } = await seedBootstrap();

  await asSystem(tenantId, async () => {
    const people = await seedPeopleAndUsers();
    await seedAuthorityGrants(people);
    const catalog = await seedCatalog();
    await seedTerritoriesAndRouting(people);
    const orgs = await seedOrganizations();
    await seedCommercialDataset(people, orgs, catalog);
    await seedEducation(people, orgs);
    await seedDemoHr(people);
    await seedDemoBooks();
    await seedDecisions(people);
    await seedMergeCandidate(people);
    await computeAndPersistAll();
  });

  // The detectors run so that the exception surfaces have live rows rather than
  // rows a fixture asserted into existence.
  await runJobsForTenant(tenantId, {
    jobNames: [
      'runMouExpiryJob',
      'runContractExpiryJob',
      'runLeadUntouchedJob',
      'runStageAgeBreachJob',
      'runProposalPendingJob',
      'runPaymentPendingJob',
      'runOfferingCoverageJob',
      'runWinLossOverdueJob',
      'runDailyMetricsJob',
      'runHealthScoreJob',
    ],
  });

  return tenantId;
}
