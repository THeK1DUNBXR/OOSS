/**
 * Leave calendar — WS3 leavepolicy (docs/hcm/leavepolicy.md).
 *
 * A team's month: who is away, on which leave type, and the holidays that
 * fall in the same window — the derived read `teamCalendar` composes from
 * `LeaveRequest` and `Holiday` rather than owning a table of its own.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, date } from '../../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';

interface OrgUnitOption {
  id: string;
  name: string;
}

interface TeamCalendarEntry {
  employmentRelationshipId: string;
  fullName: string;
  leaveTypeName: string;
  startDate: string;
  endDate: string;
  status: string;
}

interface TeamCalendarResult {
  month: string;
  entries: TeamCalendarEntry[];
  holidays: Array<{ date: string; name: string; kind: string }>;
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function LeaveCalendar() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [orgUnitId, setOrgUnitId] = useState('');

  const { data: orgUnits = [] } = useQuery({ queryKey: ['org-units'], queryFn: () => api.get<OrgUnitOption[]>('/hr/org-units') });

  const result = useQuery({
    queryKey: ['leavepolicy-team-calendar', month, orgUnitId],
    queryFn: () => api.get<TeamCalendarResult>(`/hcm/leavepolicy/team-calendar?month=${month}${orgUnitId ? `&orgUnitId=${orgUnitId}` : ''}`),
  });

  const byDay = new Map<string, TeamCalendarEntry[]>();
  for (const entry of result.data?.entries ?? []) {
    const start = new Date(entry.startDate);
    const end = new Date(entry.endDate);
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      byDay.set(key, [...(byDay.get(key) ?? []), entry]);
    }
  }

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const holidaySet = new Map((result.data?.holidays ?? []).map((h) => [h.date, h]));

  return (
    <div>
      <PageHeader
        title="Leave calendar"
        subtitle="Who on the team is away this month, and the holidays that fall alongside it."
        actions={
          <div className="flex items-center gap-2">
            <select className="input max-w-xs" value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)}>
              <option value="">Whole company</option>
              {orgUnits.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <button className="btn text-2xs" onClick={() => setMonth(shiftMonth(month, -1))}>
              ← Prev
            </button>
            <span className="text-sm font-semibold">{monthLabel(month)}</span>
            <button className="btn text-2xs" onClick={() => setMonth(shiftMonth(month, 1))}>
              Next →
            </button>
          </div>
        }
      />

      <Card>
        {result.isLoading && <Loading />}
        {result.error && <ErrorBox error={result.error} />}
        {result.data && result.data.entries.length === 0 && result.data.holidays.length === 0 && (
          <EmptyState message="Nobody has approved leave in this window, and no holiday falls in it." />
        )}
        {result.data && (result.data.entries.length > 0 || result.data.holidays.length > 0) && (
          <div className="grid grid-cols-7 gap-1 text-2xs">
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
              const key = `${month}-${String(day).padStart(2, '0')}`;
              const dayHoliday = holidaySet.get(key);
              const entries = byDay.get(key) ?? [];
              return (
                <div key={day} className={`min-h-[5rem] rounded border p-1 ${dayHoliday ? 'border-band-good/40 bg-band-good/5' : 'border-ink-800/10'}`}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{day}</span>
                  </div>
                  {dayHoliday && <div className="truncate text-band-good" title={dayHoliday.name}>{dayHoliday.name}</div>}
                  {entries.map((e, idx) => (
                    <div key={idx} className="truncate" title={`${e.fullName} — ${e.leaveTypeName}`}>
                      {e.fullName.split(' ')[0]} · {e.leaveTypeName}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {result.data && result.data.entries.length > 0 && (
        <Card title="Leave this month" className="mt-4" bodyClassName="p-0">
          <table className="table">
            <thead>
              <tr>
                <th>Who</th>
                <th>Type</th>
                <th>From</th>
                <th>To</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {result.data.entries.map((e, idx) => (
                <tr key={idx}>
                  <td>{e.fullName}</td>
                  <td>{e.leaveTypeName}</td>
                  <td className="num">{date(e.startDate)}</td>
                  <td className="num">{date(e.endDate)}</td>
                  <td>{e.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
