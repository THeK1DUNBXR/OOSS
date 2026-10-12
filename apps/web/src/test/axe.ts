import axe, { type Result } from 'axe-core';
import { expect } from 'vitest';

/**
 * Runs axe-core over a rendered subtree and returns the violations. Only
 * `violations` are asserted on: jsdom has no layout, so colour-contrast comes
 * back as "incomplete" rather than a verdict, and that is not a pass.
 */
export async function axeViolations(root: Element): Promise<Result[]> {
  const results = await axe.run(root, { resultTypes: ['violations'] });
  return results.violations;
}

/**
 * Fails with one line per violated rule, naming the rule and the nodes it
 * found, so the failure says what to fix rather than "expected [] to equal [..]".
 */
export async function expectNoAxeViolations(root: Element): Promise<void> {
  const violations = await axeViolations(root);
  const summary = violations.map(
    (v) =>
      `${v.id} (${v.impact ?? 'unrated'}): ${v.help}; nodes: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
  expect(summary).toEqual([]);
}
