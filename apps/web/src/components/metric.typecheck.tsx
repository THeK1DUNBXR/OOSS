// Compile-time guard for the Metric rule (CLAUDE.md rule 7): a number on screen
// carries a drill target or the reason it has none. There is no runtime test
// for this because the web app has no test runner; `tsc --noEmit` is the gate.
// Each @ts-expect-error below fails the build if the rule stops being enforced.
import { Metric } from './ui.js';

export function MetricWithDrill() {
  return <Metric label="Open invoices" value={3} drillTo="/finance/invoices" />;
}

export function MetricWithReason() {
  return <Metric label="Attendance" value={12} noActionReason="Computed from today's attendance snapshot; the snapshot has no per-record view yet" />;
}

export function MetricWithNeither() {
  // @ts-expect-error a Metric must carry drillTo or noActionReason
  return <Metric label="Orphan" value={1} />;
}

export function MetricWithBoth() {
  // @ts-expect-error drillTo and noActionReason are mutually exclusive
  return <Metric label="Both" value={1} drillTo="/x" noActionReason="y" />;
}
