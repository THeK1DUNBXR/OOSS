/**
 * Holder PAN is a regulated identifier (CMP-DPD-004). Every writer seals it
 * before it reaches the column, the register reads it back in full only at the
 * regulated ceiling, and a re-encrypt pass converts rows written before the
 * writers sealed it. Real Postgres throughout: the raw-column assertions read
 * what is on disk, not what the domain returns.
 */

import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { createHolder, holder, updateHolder, encryptHolderPansAtRest } from '../domains/equity.js';
import { commitImport } from '../imports/commit.js';
import { stageImport } from '../imports/service.js';
import { asUser, unscopedPrisma, withFixtureRole } from './helpers.js';

const PAN = 'ABCDE1234F';
const LAST4 = '1234';
const stamp = () => `${Date.now()}${Math.floor(Math.random() * 100000)}`;

async function rawPan(holderId: string): Promise<string | null> {
  const row = await unscopedPrisma.holder.findUniqueOrThrow({ where: { id: holderId }, select: { panNumber: true } });
  return row.panNumber;
}

describe('Holder PAN at rest', () => {
  it('createHolder stores the PAN sealed, not as the plaintext the caller gave', async () => {
    const created = await asUser('chairman@kaizen.co.in', () =>
      createHolder({
        kind: 'person',
        person: { fullName: `PAN Create ${stamp()}`, email: `pan-create-${stamp()}@example.test` },
        panNumber: PAN,
      }),
    );
    const stored = await rawPan(created.id);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain(PAN);
    expect(stored).toMatch(/^enc:v1:/);
  });

  it('updateHolder stores a PAN written after creation sealed as well', async () => {
    const created = await asUser('chairman@kaizen.co.in', () =>
      createHolder({
        kind: 'person',
        person: { fullName: `PAN Update ${stamp()}`, email: `pan-update-${stamp()}@example.test` },
      }),
    );
    await asUser('chairman@kaizen.co.in', () => updateHolder(created.id, { panNumber: PAN }));
    const stored = await rawPan(created.id);
    expect(stored).not.toContain(PAN);
    expect(stored).toMatch(/^enc:v1:/);
  });

  it('the opening-register import seals the PAN it writes to the holder', async () => {
    const className = `PanImport-${stamp()}`;
    const header = [
      'Holder name',
      'Holder kind',
      'Email',
      'Phone',
      'PAN',
      'Residency',
      'Investment basis',
      'Share class',
      'Instrument',
      'Face value',
      'Count',
      'Distinctive from',
      'Distinctive to',
      'Allotted on',
      'Price per share',
      'Certificate number',
    ];
    const holderName = `PAN Import Holder ${stamp()}`;
    const row = [
      holderName,
      'Person',
      `pan-import-${stamp()}@example.test`,
      '',
      PAN,
      'Resident',
      '',
      className,
      'Equity',
      '10',
      '1000',
      '1',
      '1000',
      '01/04/2020',
      '',
      `PAN-IMPORT/${stamp()}`,
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header, row]), 'Data');
    const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const staged = await asUser('chairman@kaizen.co.in', () =>
      stageImport({ fileName: 'opening-register.xlsx', buffer }),
    );
    const committed = await asUser('chairman@kaizen.co.in', () => commitImport(staged.batchId));
    expect(committed.errors).toEqual([]);

    const person = await unscopedPrisma.person.findFirstOrThrow({
      where: { fullName: holderName },
      select: { id: true },
    });
    const created = await unscopedPrisma.holder.findFirstOrThrow({
      where: { personId: person.id },
      select: { id: true },
    });
    const stored = await rawPan(created.id);
    expect(stored).not.toContain(PAN);
    expect(stored).toMatch(/^enc:v1:/);
  });
});

describe('Holder PAN on read', () => {
  it('a regulated caller reads the PAN in full', async () => {
    const created = await asUser('chairman@kaizen.co.in', () =>
      createHolder({
        kind: 'person',
        person: { fullName: `PAN Regulated ${stamp()}`, email: `pan-reg-${stamp()}@example.test` },
        panNumber: PAN,
      }),
    );
    const view = await asUser('chairman@kaizen.co.in', () => holder(created.id));
    expect(view.panNumber).toBe(PAN);
  });

  it('a caller below the regulated ceiling reads the PAN masked, never in full', async () => {
    const created = await asUser('chairman@kaizen.co.in', () =>
      createHolder({
        kind: 'person',
        person: { fullName: `PAN Masked ${stamp()}`, email: `pan-mask-${stamp()}@example.test` },
        panNumber: PAN,
      }),
    );
    await withFixtureRole(
      {
        slug: 'pan_viewer',
        classificationCeiling: 'confidential',
        grants: [{ resource: 'holders', verbs: ['view'], scope: 'all' }],
      },
      async () => {
        const view = await holder(created.id);
        expect(view.panNumber).not.toBe(PAN);
        expect(view.panNumber).not.toContain(PAN);
        expect(view.panNumber?.endsWith(LAST4)).toBe(true);
        expect(view.panNumber?.slice(0, -4)).toMatch(/^X+$/);
      },
    );
  });
});

describe('Holder PAN re-encrypt pass', () => {
  it('converts a plaintext PAN once, and a second run converts nothing', async () => {
    const created = await asUser('chairman@kaizen.co.in', () =>
      createHolder({
        kind: 'person',
        person: { fullName: `PAN Backfill ${stamp()}`, email: `pan-bf-${stamp()}@example.test` },
      }),
    );
    // Written around the domain writer, as rows from before it sealed PAN are.
    await unscopedPrisma.holder.update({ where: { id: created.id }, data: { panNumber: PAN } });
    expect(await rawPan(created.id)).toBe(PAN);

    const first = await asUser('chairman@kaizen.co.in', () => encryptHolderPansAtRest());
    expect(first.valuesEncrypted).toBeGreaterThanOrEqual(1);
    const sealed = await rawPan(created.id);
    expect(sealed).not.toContain(PAN);
    expect(sealed).toMatch(/^enc:v1:/);

    const second = await asUser('chairman@kaizen.co.in', () => encryptHolderPansAtRest());
    expect(second.valuesEncrypted).toBe(0);
    expect(await rawPan(created.id)).toBe(sealed);

    const view = await asUser('chairman@kaizen.co.in', () => holder(created.id));
    expect(view.panNumber).toBe(PAN);
  });
});
