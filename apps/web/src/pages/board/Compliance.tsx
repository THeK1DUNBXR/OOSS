/**
 * The board compliance calendar — due dates computed from recorded facts by
 * the daily `board_compliance` job, never guessed from an empty register.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComplianceItemView } from '@kaizen/shared';
import { api, date } from '../../lib/api.js';
import { useSession } from '../../lib/session.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusChip } from '../../components/ui.js';
import { TextInput, messageOf } from '../../components/forms.js';

export function Compliance() {
  const { can } = useSession();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['board', 'compliance'],
    queryFn: () => api.get<{ items: ComplianceItemView[] }>('/board/compliance'),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <PageHeader title="Compliance" subtitle="SS-1, MBP-1, MGT-14 and AGM due dates — each computed from what has actually been recorded." />

      <Card bodyClassName="p-0">
        {isLoading ? (
          <div className="p-4"><Loading /></div>
        ) : data!.items.length === 0 ? (
          <div className="p-4">
            <EmptyState message="Nothing is due. Items appear as meetings and resolutions are recorded." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-2xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2 font-medium">Due</th>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Basis</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  {can('compliance:E') && <th className="px-4 py-2 font-medium">Action</th>}
                </tr>
              </thead>
              <tbody>
                {data!.items.map((i) => (
                  <ComplianceRow key={i.id} item={i} canEdit={can('compliance:E')} onDone={() => qc.invalidateQueries({ queryKey: ['board', 'compliance'] })} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function ComplianceRow({ item, canEdit, onDone }: { item: ComplianceItemView; canEdit: boolean; onDone: () => void }) {
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const resolve = useMutation({
    mutationFn: (input: { waived?: boolean; reason?: string }) => api.post(`/board/compliance/${item.id}/resolve`, input),
    onSuccess: () => {
      setError(null);
      onDone();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  return (
    <tr className="border-b border-ink-850 align-top">
      <td className="whitespace-nowrap px-4 py-2.5 text-ink-200">{date(item.dueOn)}</td>
      <td className="px-4 py-2.5">
        <p className="font-medium text-ink-100">{item.title}</p>
        {error && <p className="text-2xs text-band-critical">{error}</p>}
      </td>
      <td className="max-w-sm px-4 py-2.5 text-2xs text-ink-500">{item.basis}</td>
      <td className="px-4 py-2.5">
        {item.status === 'open' ? (
          item.overdue ? <StatusChip status="Overdue" tone="bad" /> : <StatusChip status="Open" tone="accent" />
        ) : (
          <StatusChip status={item.status === 'done' ? 'Done' : 'Waived'} tone={item.status === 'done' ? 'good' : 'neutral'} />
        )}
      </td>
      {canEdit && (
        <td className="px-4 py-2.5">
          {item.status === 'open' && (
            <div className="flex flex-col items-start gap-1.5">
              <div className="flex gap-2">
                <button className="btn" onClick={() => resolve.mutate({})}>
                  Resolve
                </button>
                <button className="btn" onClick={() => setWaiving((w) => !w)}>
                  Waive
                </button>
              </div>
              {waiving && (
                <form
                  className="flex items-end gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    resolve.mutate({ waived: true, reason });
                  }}
                >
                  <TextInput label="Reason" required value={reason} onChange={setReason} />
                  <button className="btn-primary" type="submit" disabled={!reason}>
                    Confirm waiver
                  </button>
                </form>
              )}
            </div>
          )}
        </td>
      )}
    </tr>
  );
}
