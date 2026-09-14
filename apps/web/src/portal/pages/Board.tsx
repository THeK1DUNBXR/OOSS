import { PageHeader, EmptyState } from '../../components/ui.js';

/** Phase 0 placeholder — meetings, agenda and minutes are phase 3 (plan §6). */
export function Board() {
  return (
    <div>
      <PageHeader title="Board" />
      <EmptyState
        message="No meeting has been called yet."
        hint="Notices, agendas and minutes appear here once meetings begin being recorded."
      />
    </div>
  );
}
