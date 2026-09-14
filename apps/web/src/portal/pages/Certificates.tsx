import { PageHeader, EmptyState } from '../../components/ui.js';

/** Phase 0 placeholder — certificates are issued from phase 1 (plan §6). */
export function Certificates() {
  return (
    <div>
      <PageHeader title="Certificates" />
      <EmptyState
        message="No certificate has been issued to you yet."
        hint="A certificate appears here the day it is issued, and can be printed from this screen."
      />
    </div>
  );
}
