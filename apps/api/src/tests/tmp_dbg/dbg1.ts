import { asUser, expectReject, prisma, tenantId, unscopedPrisma } from '../helpers.js';
import { recordClockEvent } from '../../domains/hcm/time.js';

async function main() {
  const TENANT = await tenantId();
  const user = await unscopedPrisma.user.findFirstOrThrow({ where: { email: 'divya@kaizen.co.in', tenant: { slug: 'kaizen' } } });
  const employment = await unscopedPrisma.employmentRelationship.findFirstOrThrow({ where: { tenantId: TENANT, personId: user.personId }, orderBy: { hireEffectiveDate: 'desc' } });
  const day = new Date(Date.now() + 400*86400000);
  await asUser('divya@kaizen.co.in', async () => {
    const r1 = await recordClockEvent({ employmentRelationshipId: employment.id, kind: 'in', occurredAt: new Date(day.getTime()+9*3600000) });
    console.log('r1', r1.id, r1.kind, r1.occurredAt);
    try {
      const r2 = await recordClockEvent({ employmentRelationshipId: employment.id, kind: 'in', occurredAt: new Date(day.getTime()+9.5*3600000) });
      console.log('r2 UNEXPECTEDLY SUCCEEDED', r2.id, r2.kind);
    } catch (e:any) {
      console.log('r2 rejected as expected:', e.message);
    }
  });
}
main().then(()=>process.exit(0)).catch((e)=>{console.error(e);process.exit(1)});
