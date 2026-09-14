import { PageHeader, EmptyState } from '../../components/ui.js';

/** Phase 0 placeholder — the register itself lands in phase 1 (plan §6). */
export function Holdings() {
  return (
    <div>
      <PageHeader title="Holdings" />
      <EmptyState
        message="No shareholding has been recorded for you yet."
        hint="The register opens in the next release; your holdings appear here the day they are entered."
      />
    </div>
  );
}
