/**
 * Write-path hooks.
 *
 * Added with the compliance work (docs/plan/compliance.md) so that a
 * workstream can attach a rule to another module's write path without editing
 * that module. A vendor bill cannot be paid until its TDS is settled, but the
 * TDS rule lives in the tax module and paying a bill lives in the books: the
 * books call `runHooks('vendor_bill.before_pay', bill)` at the point of
 * payment, and the tax module registers what must hold there.
 *
 * A hook that throws vetoes the write; the error reaches the caller unchanged,
 * so a hook raises `ApiError` with a named reason like any other rule. Hooks
 * run in registration order and are awaited one at a time — a rule is a rule,
 * not a race.
 *
 * Hook points and what the payload is, all registered by the module that owns
 * the write and consumed by whoever needs to:
 *
 *   vendor_bill.before_pay        { bill }                    books
 *   transaction.before_record     { txnDate, source }         books
 *   invoice.before_issue          { invoice, lines }          invoicing
 *   payroll_run.before_approve    { run, instructions }       payroll
 *   payroll_run.approved          { run, instructions }       payroll
 *   offboarding.completed         { employmentRelationship }  employment
 *   audit.after_write             { record }                  audit
 */

export type HookName =
  | 'vendor_bill.before_pay'
  | 'transaction.before_record'
  | 'invoice.before_issue'
  | 'payroll_run.before_approve'
  | 'payroll_run.approved'
  | 'offboarding.completed'
  | 'audit.after_write';

export type HookFn = (payload: Record<string, unknown>) => Promise<void> | void;

const registry = new Map<HookName, Array<{ key: string; fn: HookFn }>>();

/** Registers `fn` under `key`; re-registering the same key replaces, so a module reloaded in tests does not double-fire. */
export function registerHook(name: HookName, key: string, fn: HookFn): void {
  const list = registry.get(name) ?? [];
  const idx = list.findIndex((h) => h.key === key);
  if (idx >= 0) list[idx] = { key, fn };
  else list.push({ key, fn });
  registry.set(name, list);
}

/** Runs every hook registered at `name`, in order, awaiting each. */
export async function runHooks(name: HookName, payload: Record<string, unknown>): Promise<void> {
  for (const h of registry.get(name) ?? []) await h.fn(payload);
}

export function hookCount(name: HookName): number {
  return registry.get(name)?.length ?? 0;
}
