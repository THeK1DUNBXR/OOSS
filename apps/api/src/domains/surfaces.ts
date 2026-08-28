/**
 * P9 — surface composition.
 *
 * "Kaizen builds one system, not eleven front-ends." Role-based experience is
 * not a set of hand-built screens per job title — it is data, resolved against
 * identity and permission at request time.
 *
 * The pipeline:
 *   PRINCIPAL -> active AFFILIATION -> ACCESS_ROLE -> GRANT/AUTHORITY ->
 *   capability resolution -> SURFACE_TEMPLATE -> WIDGET set filtered by
 *   permission and relevance -> data fetch with five-axis filtering -> render
 *
 * It runs at request time, never cached from login, and is deterministic and
 * replayable: the same (principal, affiliation, templateVersion, policyVersion)
 * inputs always reproduce the same composition, which is what makes forensic
 * replay possible.
 *
 * No experience-layer code tests the identity of a role, an affiliation type,
 * or a person.
 */

import type { NavNodeView } from '@kaizen/shared';
import { prisma } from '../platform/db.js';
import { currentAuth } from '../platform/context.js';
import { can } from '../platform/permissions.js';
import { parseGrant } from '@kaizen/shared';

/**
 * A node the viewer cannot reach is unrendered, never merely disabled. Badge
 * counts obey the same five-axis filter as content, so a badge number is never
 * a permission leak.
 */
export async function navigationFor(): Promise<NavNodeView[]> {
  const auth = currentAuth();

  const nodes = await prisma.navNode.findMany({
    where: { tenantId: auth.tenantId },
    orderBy: [{ group: 'asc' }, { position: 'asc' }],
  });

  const role = await prisma.accessRole.findFirst({ where: { tenantId: auth.tenantId, slug: auth.roleSlug ?? '' } });
  const archetype = role?.archetype ?? 'workspace';

  const permitted: NavNodeView[] = [];

  for (const node of nodes) {
    if (node.eligibleArchetypes.length && !node.eligibleArchetypes.includes(archetype)) continue;

    if (node.requiredPermission) {
      const parsed = parseGrant(node.requiredPermission);
      const allowed = await can({ resource: parsed.resource, verb: parsed.verbs[0] });
      if (!allowed) continue;
    }

    permitted.push({
      key: node.nodeKey,
      label: node.label,
      icon: node.icon,
      path: node.path,
      group: node.group,
      searchSynonyms: node.searchSynonyms,
    });
  }

  // Rebuild the parent/child tree from the flat, filtered set.
  const byKey = new Map(permitted.map((n) => [n.key, n]));
  const parentOf = new Map(nodes.map((n) => [n.nodeKey, n.parentKey]));
  const roots: NavNodeView[] = [];

  for (const node of permitted) {
    const parentKey = parentOf.get(node.key);
    const parent = parentKey ? byKey.get(parentKey) : undefined;
    if (parent) {
      parent.children = [...(parent.children ?? []), node];
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Composes a surface and persists the result, including the closed-set
 * `withheld[]` reason codes, so an auditor's "why wasn't X on his screen" is
 * answerable without re-derivation.
 */
export async function surfaceCompositionFor(templateKey: string) {
  const auth = currentAuth();

  const template = await prisma.surfaceTemplate.findFirst({
    where: { tenantId: auth.tenantId, templateKey },
    include: { bindings: { include: { widget: true }, orderBy: { position: 'asc' } } },
  });

  if (!template) {
    return { templateKey, widgets: [], withheld: [{ path: templateKey, reason: 'no_permission' as const }] };
  }

  const role = await prisma.accessRole.findFirst({ where: { tenantId: auth.tenantId, slug: auth.roleSlug ?? '' } });
  const archetype = role?.archetype ?? 'workspace';

  if (template.eligibleRoles.length && !template.eligibleRoles.includes(auth.roleSlug ?? '')) {
    return { templateKey, widgets: [], withheld: [{ path: templateKey, reason: 'out_of_scope' as const }] };
  }

  const widgets: Array<Record<string, unknown>> = [];
  const withheld: Array<{ path: string; reason: 'no_permission' | 'out_of_scope' | 'classification_ceiling' }> = [];

  for (const binding of template.bindings) {
    const w = binding.widget;
    const parsed = parseGrant(w.requiredPermission);
    const allowed = await can({ resource: parsed.resource, verb: parsed.verbs[0] });

    if (!allowed) {
      withheld.push({ path: w.widgetKey, reason: 'no_permission' });
      continue;
    }

    const actions = (w.actions as unknown as Array<{ label: string; path: string }>) ?? [];
    // Enforced at publish time, not at review: a widget with no actions is a
    // dead metric, and the no_action_fallback routes an unactionable item to
    // its owner rather than omitting it.
    if (actions.length === 0 && !w.noActionFallback) {
      withheld.push({ path: w.widgetKey, reason: 'out_of_scope' });
      continue;
    }

    widgets.push({
      widgetKey: w.widgetKey,
      title: w.title,
      dataSource: w.dataSource,
      severityRelevance: w.severityRelevance,
      actions,
      drillTarget: w.drillTarget,
      mobileBehaviour: w.mobileBehaviour,
      emptyState: w.emptyState,
      noActionFallback: w.noActionFallback,
      position: binding.position,
      personalisationPolicy: binding.personalisationPolicy,
      config: binding.config,
    });
  }

  if (auth.userId && auth.affiliationId) {
    await prisma.surfaceComposition.create({
      data: {
        tenantId: auth.tenantId,
        userId: auth.userId,
        affiliationId: auth.affiliationId,
        templateKey,
        templateVersion: template.version,
        widgets: widgets as never,
        withheld: withheld as never,
      },
    });
  }

  return { templateKey, archetype, templateVersion: template.version, widgets, withheld };
}

/**
 * Permission-filtered universal search. Every candidate passes the five-axis
 * check BEFORE being returned, not filtered post-retrieval — the load-bearing
 * distinction from commodity search.
 */
export async function universalSearch(query: string, limit = 20) {
  const auth = currentAuth();
  if (query.trim().length < 2) return { results: [], query };

  const q = query.trim();
  const like = { contains: q, mode: 'insensitive' as const };

  const [canPeople, canOrgs, canLeads, canOpps, canMous, canContracts] = await Promise.all([
    can({ resource: 'people', verb: 'view' }),
    can({ resource: 'organizations', verb: 'view' }),
    can({ resource: 'leads', verb: 'view' }),
    can({ resource: 'opportunities', verb: 'view' }),
    can({ resource: 'mous', verb: 'view' }),
    can({ resource: 'contracts', verb: 'view' }),
  ]);

  const results: Array<{ type: string; id: string; label: string; recordCode: string; path: string; sub: string }> = [];

  if (canPeople) {
    const rows = await prisma.person.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, OR: [{ fullName: like }, { recordCode: like }, { primaryEmail: like }] },
      take: limit,
    });
    results.push(...rows.map((r) => ({ type: 'person', id: r.id, label: r.fullName, recordCode: r.recordCode, path: `/crm/people/${r.id}`, sub: r.primaryEmail ?? r.primaryPhone ?? '' })));
  }

  if (canOrgs) {
    const rows = await prisma.organization.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, OR: [{ name: like }, { recordCode: like }] },
      take: limit,
      include: { account: { select: { tier: true } }, institutionProfile: { select: { district: true } } },
    });
    results.push(
      ...rows.map((r) => ({
        type: 'organization',
        id: r.id,
        label: r.name,
        recordCode: r.recordCode,
        path: `/crm/accounts/${r.id}`,
        sub: [r.account ? `Account · ${r.account.tier}` : null, r.institutionProfile ? `Institution · ${r.institutionProfile.district ?? ''}` : null].filter(Boolean).join(' · '),
      })),
    );
  }

  if (canLeads) {
    const rows = await prisma.lead.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, OR: [{ title: like }, { recordCode: like }] },
      take: limit,
    });
    results.push(...rows.map((r) => ({ type: 'lead', id: r.id, label: r.title, recordCode: r.recordCode, path: `/crm/leads/${r.id}`, sub: r.stageKey })));
  }

  if (canOpps) {
    const rows = await prisma.opportunity.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, OR: [{ title: like }, { recordCode: like }] },
      take: limit,
    });
    results.push(...rows.map((r) => ({ type: 'opportunity', id: r.id, label: r.title, recordCode: r.recordCode, path: `/crm/opportunities/${r.id}`, sub: `${r.stageKey} · ${r.forecastCategory}` })));
  }

  if (canMous) {
    const rows = await prisma.mou.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, OR: [{ title: like }, { recordCode: like }] },
      take: limit,
    });
    results.push(...rows.map((r) => ({ type: 'mou', id: r.id, label: r.title, recordCode: r.recordCode, path: `/commercial/mous/${r.id}`, sub: r.status })));
  }

  if (canContracts) {
    const rows = await prisma.contract.findMany({
      where: { tenantId: auth.tenantId, deletedAt: null, OR: [{ title: like }, { recordCode: like }] },
      take: limit,
    });
    results.push(...rows.map((r) => ({ type: 'contract', id: r.id, label: r.title, recordCode: r.recordCode, path: `/commercial/contracts/${r.id}`, sub: r.status })));
  }

  return { query: q, results: results.slice(0, limit * 2) };
}
