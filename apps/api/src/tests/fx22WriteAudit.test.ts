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

// ---------------------------------------------------------------------------
// Part 2: commercial, decisions, pipeline routes, and the education emits.
// Each block makes one HTTP call and asserts the single row (or event) that
// the write is required to leave. Authority and state are the fixture's own.
// ---------------------------------------------------------------------------

async function auditRow(subjectType: string, subjectId: string, action: string) {
  return unscopedPrisma.auditRecord.findFirst({
    where: { tenantId: await tenantId(), subjectType, subjectId, action },
  });
}

async function eventRow(eventName: string, subjectEntityId: string) {
  return unscopedPrisma.eventRecord.findFirst({
    where: { tenantId: await tenantId(), eventName, subjectEntityId },
  });
}

async function send(p: TestPrincipal, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: headersFor(p),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('FX-22: commercial proposal and quote writes leave audit rows', () => {
  it('POST /commercial/proposals audits the proposal create', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const opp = await unscopedPrisma.opportunity.findFirstOrThrow({ where: { tenantId: chairman.tenantId, deletedAt: null } });
    const res = await send(chairman, 'POST', '/commercial/proposals', { opportunityId: opp.id, title: `fx22-proposal-${Date.now()}` });
    expect(res.status).toBe(201);
    const proposal = (await res.json()) as { id: string };
    expect(await auditRow('proposal', proposal.id, 'create')).not.toBeNull();
  });

  it('POST /commercial/proposals/:id/send audits the proposal update', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const proposal = await unscopedPrisma.proposal.findFirstOrThrow({ where: { tenantId: chairman.tenantId, sentAt: null } });
    const res = await send(chairman, 'POST', `/commercial/proposals/${proposal.id}/send`);
    expect(res.status).toBe(200);
    expect(await auditRow('proposal', proposal.id, 'update')).not.toBeNull();
  });

  it('POST /commercial/quotes audits the quote create', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const opp = await unscopedPrisma.opportunity.findFirstOrThrow({ where: { tenantId: chairman.tenantId, deletedAt: null } });
    const entry = await unscopedPrisma.priceBookEntry.findFirstOrThrow({ where: { tenantId: chairman.tenantId, currency: opp.currency } });
    const res = await send(chairman, 'POST', '/commercial/quotes', {
      opportunityId: opp.id,
      lines: [{ priceBookEntryId: entry.id, quantity: 1, discountPct: 0 }],
    });
    expect(res.status).toBe(201);
    const quote = (await res.json()) as { id: string };
    expect(await auditRow('quote', quote.id, 'create')).not.toBeNull();
  });

  it('POST /commercial/quotes/:id/issue audits the quote update', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const quote = await unscopedPrisma.quote.findFirstOrThrow({
      where: { tenantId: chairman.tenantId, status: 'draft', lines: { every: { discountPct: 0 } } },
      include: { lines: true },
    });
    const res = await send(chairman, 'POST', `/commercial/quotes/${quote.id}/issue`, {});
    expect(res.status).toBe(200);
    expect(await auditRow('quote', quote.id, 'update')).not.toBeNull();
  });
});

describe('FX-22: decision writes leave audit rows', () => {
  it('POST /command/decisions audits the decision create', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const opp = await unscopedPrisma.opportunity.findFirstOrThrow({ where: { tenantId: chairman.tenantId, deletedAt: null } });
    const res = await send(chairman, 'POST', '/command/decisions', {
      question: `fx22 decision ${Date.now()}`,
      subjectType: 'opportunity',
      subjectId: opp.id,
      authorityBasis: 'discount_approval',
    });
    expect(res.status).toBe(201);
    const decision = (await res.json()) as { id: string };
    expect(await auditRow('decision', decision.id, 'create')).not.toBeNull();
  });

  it('request_evidence disposition audits the decision update', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const decision = await unscopedPrisma.decision.findFirstOrThrow({ where: { tenantId: chairman.tenantId, evidenceComplete: false } });
    const res = await send(chairman, 'POST', `/command/decisions/${decision.id}/dispose`, {
      disposition: 'request_evidence',
      rationale: 'fx22 evidence request',
    });
    expect(res.status).toBe(200);
    expect(await auditRow('decision', decision.id, 'update')).not.toBeNull();
  });

  it('delegate disposition audits the delegation create', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const decision = await unscopedPrisma.decision.findFirstOrThrow({
      where: { tenantId: chairman.tenantId, evidenceComplete: true },
    });
    const res = await send(chairman, 'POST', `/command/decisions/${decision.id}/dispose`, {
      disposition: 'delegate',
      rationale: 'fx22 delegation',
      delegateToPartyId: chairman.partyId,
      returnDueOn: '2026-12-31',
    });
    expect(res.status).toBe(200);
    // Newest first: the fixture decision is reused across runs, so an older delegation may already exist.
    const delegation = await unscopedPrisma.delegation.findFirstOrThrow({
      where: { decisionId: decision.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(await auditRow('delegation', delegation.id, 'create')).not.toBeNull();
  });

  it('POST /command/decisions/:id/review audits the lesson create and the decision update', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const decision = await unscopedPrisma.decision.findFirstOrThrow({ where: { tenantId: chairman.tenantId } });
    const res = await send(chairman, 'POST', `/command/decisions/${decision.id}/review`, {
      outcomeAssessment: 'fx22 outcome',
      varianceBand: 'within',
      lesson: 'fx22 lesson',
      changeCommitment: 'fx22 commitment',
    });
    expect(res.status).toBe(200);
    expect(await auditRow('decision', decision.id, 'update')).not.toBeNull();
    const lesson = await unscopedPrisma.lesson.findFirstOrThrow({
      where: { sourceId: decision.id, body: 'fx22 lesson' },
      orderBy: { createdAt: 'desc' },
    });
    expect(await auditRow('lesson', lesson.id, 'create')).not.toBeNull();
  });
});

describe('FX-22: pipeline route writes leave audit rows', () => {
  it('PATCH /pipelines/stages/:id audits the stage update', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const stage = await unscopedPrisma.pipelineStage.findFirstOrThrow({ where: { tenantId: chairman.tenantId, retiredAt: null } });
    const res = await send(chairman, 'PATCH', `/pipelines/stages/${stage.id}`, { label: `fx22 ${Date.now()}` });
    expect(res.status).toBe(200);
    expect(await auditRow('pipeline_stage', stage.id, 'update')).not.toBeNull();
  });

  it('DELETE /pipelines/transitions/:id audits the transition delete', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const pipeline = await unscopedPrisma.pipelineDefinition.findFirstOrThrow({ where: { tenantId: chairman.tenantId } });
    const transition = await unscopedPrisma.pipelineTransition.create({
      data: { tenantId: chairman.tenantId, pipelineId: pipeline.id, fromStageKey: null, toStageKey: `fx22-${Date.now()}` },
    });
    const res = await send(chairman, 'DELETE', `/pipelines/transitions/${transition.id}`);
    expect(res.status).toBe(200);
    expect(await auditRow('pipeline_transition', transition.id, 'delete')).not.toBeNull();
  });

  it('POST /pipelines/territories/all audits the territory create', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const res = await send(chairman, 'POST', '/pipelines/territories/all', { name: `fx22-territory-${Date.now()}` });
    expect(res.status).toBe(201);
    const territory = (await res.json()) as { id: string };
    expect(await auditRow('territory', territory.id, 'create')).not.toBeNull();
  });

  it('PATCH /pipelines/routing-rules/:id audits the routing rule update', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const rule = await unscopedPrisma.routingRule.findFirstOrThrow({ where: { tenantId: chairman.tenantId } });
    const margin = 1 + Math.floor(Math.random() * 50);
    const res = await send(chairman, 'PATCH', `/pipelines/routing-rules/${rule.id}`, { tieBreakMarginPoints: margin });
    expect(res.status).toBe(200);
    expect(await auditRow('routing_rule', rule.id, 'update')).not.toBeNull();
  });
});

describe('FX-22: education cohort and project writes emit events', () => {
  it('POST /education/cohorts emits kz.edu.cohort.created', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const course = await unscopedPrisma.course.findFirstOrThrow({ where: { tenantId: chairman.tenantId } });
    const res = await send(chairman, 'POST', '/education/cohorts', {
      courseId: course.id,
      name: `fx22-emit-${Date.now()}`,
      startDate: '2026-11-01',
    });
    expect(res.status).toBe(201);
    const cohort = (await res.json()) as { id: string };
    expect(await eventRow('kz.edu.cohort.created', cohort.id)).not.toBeNull();
  });

  it('PATCH /education/projects/:id emits kz.prj.project.updated', async () => {
    const chairman = await principalFor('chairman@kaizen.co.in');
    const project = await unscopedPrisma.project.findFirstOrThrow({ where: { tenantId: chairman.tenantId } });
    const res = await send(chairman, 'PATCH', `/education/projects/${project.id}`, { healthBand: `fx22-${Date.now()}` });
    expect(res.status).toBe(200);
    expect(await eventRow('kz.prj.project.updated', project.id)).not.toBeNull();
  });
});
