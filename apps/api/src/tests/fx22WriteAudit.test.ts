/**
 * FX-22 — writes that left no audit row.
 *
 * The education routes wrote cohorts and project status changes straight to
 * the database: no `auditWrite`, so the change never reached the audit log.
 * These go over HTTP, as the chairman, and then look for the row that the
 * write is required to leave. Real database, real route, real evaluator.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server.js';
import { signToken } from '../lib/auth.js';
import { principalFor, tenantId, unscopedPrisma, type TestPrincipal } from './helpers.js';

let server: Server;
let base: string;

beforeAll(() => {
  server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}/api`;
});

afterAll(() => {
  server?.close();
});

function headersFor(p: TestPrincipal): Record<string, string> {
  const token = signToken({ userId: p.userId, tenantId: p.tenantId, affiliationId: p.affiliationId, stepUp: true });
  return { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('FX-22: POST /education/cohorts leaves a cohort create audit row', () => {
  it('the created cohort has an audit record', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const course = await unscopedPrisma.course.findFirstOrThrow({ where: { tenantId: chairman.tenantId } });
    const res = await fetch(`${base}/education/cohorts`, {
      method: 'POST',
      headers: headersFor(chairman),
      body: JSON.stringify({ courseId: course.id, name: `fx22-cohort-${Date.now()}`, startDate: '2026-11-01' }),
    });
    expect(res.status).toBe(201);
    const cohort = (await res.json()) as { id: string };
    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: await tenantId(), subjectType: 'cohort', subjectId: cohort.id, action: 'create' },
    });
    expect(audit).not.toBeNull();
  });
});

describe('FX-22: PATCH /education/projects/:id leaves a project update audit row', () => {
  it('the status change has an audit record with the before and after', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const project = await unscopedPrisma.project.findFirstOrThrow({
      where: { tenantId: chairman.tenantId, status: { not: 'on_hold' } },
    });
    const res = await fetch(`${base}/education/projects/${project.id}`, {
      method: 'PATCH',
      headers: headersFor(chairman),
      body: JSON.stringify({ status: 'on_hold' }),
    });
    expect(res.status).toBe(200);
    const audit = await unscopedPrisma.auditRecord.findFirst({
      where: { tenantId: chairman.tenantId, subjectType: 'project', subjectId: project.id, action: 'update' },
      orderBy: { timestamp: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.diff)).toContain('on_hold');
  });
});
