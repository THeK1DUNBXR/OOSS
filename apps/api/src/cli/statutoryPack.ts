import { readFile } from 'node:fs/promises';
import { unscopedPrisma } from '../platform/db.js';

interface RuleLike {
  domain: string;
  key: string;
  jurisdiction: string;
  effectiveFrom: string | Date;
  value: unknown;
  source: string;
}

interface PackRule extends RuleLike {
  effectiveFrom: string;
  effectiveTo?: string | null;
}

function identity(rule: RuleLike): string {
  return [rule.domain, rule.key, rule.jurisdiction, new Date(rule.effectiveFrom).toISOString()].join('|');
}

async function main() {
  const [command, packPath] = process.argv.slice(2);
  if (command !== 'diff' || !packPath) {
    throw new Error('Usage: pnpm --filter @kaizen/api statutory-pack diff <pack.json>');
  }
  const input = JSON.parse(await readFile(packPath, 'utf8')) as PackRule[];
  const installed = await unscopedPrisma.statutoryRule.findMany({ where: { tenantId: null } });
  const oldById = new Map(installed.map((rule) => [identity(rule), rule]));
  const changes: Array<Record<string, unknown>> = input.flatMap((rule) => {
    const old = oldById.get(identity(rule));
    if (!old) return [{ type: 'added', rule }];
    if (JSON.stringify(old.value) !== JSON.stringify(rule.value) || old.source !== rule.source) {
      return [{ type: 'changed', rule, previous: { value: old.value, source: old.source } }];
    }
    return [];
  });
  const incoming = new Set(input.map(identity));
  changes.push(...installed.filter((rule) => !incoming.has(identity(rule))).map((rule) => ({ type: 'removed', rule })));
  console.log(JSON.stringify({ changedRules: changes.length, affectedTenants: 'tenant-specific overrides must be reviewed', changes }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => unscopedPrisma.$disconnect());
