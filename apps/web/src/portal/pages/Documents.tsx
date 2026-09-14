import { PageHeader, EmptyState } from '../../components/ui.js';

/** Phase 0 placeholder — shared documents land alongside the register in a
 *  later phase. */
export function Documents() {
  return (
    <div>
      <PageHeader title="Documents" />
      <EmptyState
        message="Nothing has been shared with shareholders yet."
        hint="A document appears here the day the company shares it with you."
      />
    </div>
  );
}
