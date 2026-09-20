/**
 * Marketing calendar — a month grid built with plain divs (no calendar
 * library), coloured by item kind and status.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui.js';
import { useCalendar, type CalendarItem } from '../../lib/marketingApi.js';

const KIND_COLOUR: Record<CalendarItem['kind'], string> = {
  campaign: 'bg-div-software/15 text-div-software border-div-software/30',
  event: 'bg-div-education/15 text-div-education border-div-education/30',
  send: 'bg-div-skill/15 text-div-skill border-div-skill/30',
  social_post: 'bg-div-shared/15 text-div-shared border-div-shared/30',
};

const KIND_LABEL: Record<CalendarItem['kind'], string> = {
  campaign: 'Campaign',
  event: 'Event',
  send: 'Send',
  social_post: 'Social',
};

function monthGrid(year: number, month: number): Date[] {
  const first = new Date(Date.UTC(year, month, 1));
  const startDow = first.getUTCDay();
  const gridStart = new Date(first);
  gridStart.setUTCDate(first.getUTCDate() - startDow);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    return d;
  });
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function routeFor(item: CalendarItem): string {
  switch (item.kind) {
    case 'campaign':
      return `/marketing/campaigns/${item.id}`;
    case 'event':
      return `/marketing/events/${item.id}`;
    case 'send':
      return `/marketing/sends/${item.id}`;
    case 'social_post':
      return `/marketing/social/${item.id}`;
  }
}

export function Calendar() {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(() => {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() };
  });

  const days = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const from = isoDay(days[0]);
  const to = isoDay(days[days.length - 1]);

  const { data, isLoading, error } = useCalendar({ from, to });

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of data ?? []) {
      const start = item.startAt.slice(0, 10);
      const end = item.endAt ? item.endAt.slice(0, 10) : start;
      let cursorDay = start;
      // Spread multi-day items across every day they span, capped generously.
      for (let i = 0; i < 60 && cursorDay <= end; i++) {
        if (!map.has(cursorDay)) map.set(cursorDay, []);
        map.get(cursorDay)!.push(item);
        const next = new Date(`${cursorDay}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        cursorDay = isoDay(next);
      }
    }
    return map;
  }, [data]);

  const monthLabel = new Date(Date.UTC(cursor.year, cursor.month, 1)).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Campaigns, events, sends and social posts, laid out by date."
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-ghost" onClick={() => setCursor((c) => (c.month === 0 ? { year: c.year - 1, month: 11 } : { year: c.year, month: c.month - 1 }))}>
              ←
            </button>
            <span className="min-w-[10ch] text-center text-sm font-medium text-ink-100">{monthLabel}</span>
            <button className="btn-ghost" onClick={() => setCursor((c) => (c.month === 11 ? { year: c.year + 1, month: 0 } : { year: c.year, month: c.month + 1 }))}>
              →
            </button>
          </div>
        }
      />

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox error={error} />
      ) : (data ?? []).length === 0 ? (
        <Card>
          <EmptyState message="Nothing is scheduled this month." hint="Campaigns, events, sends and social posts appear here once dated." />
        </Card>
      ) : (
        <Card bodyClassName="p-2">
          <div className="grid grid-cols-7 gap-1 text-center text-2xs font-semibold uppercase tracking-wide text-ink-500">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map((d) => {
              const key = isoDay(d);
              const items = byDay.get(key) ?? [];
              const inMonth = d.getUTCMonth() === cursor.month;
              return (
                <div
                  key={key}
                  className={`min-h-[92px] rounded-md border border-ink-800 p-1.5 ${inMonth ? 'bg-ink-900' : 'bg-ink-950/40 opacity-50'}`}
                >
                  <p className="mb-1 text-2xs tabular-nums text-ink-500">{d.getUTCDate()}</p>
                  <div className="flex flex-col gap-0.5">
                    {items.slice(0, 3).map((item) => (
                      <button
                        key={`${item.kind}-${item.id}`}
                        onClick={() => navigate(routeFor(item))}
                        title={`${KIND_LABEL[item.kind]} · ${item.status} · ${item.division}`}
                        className={`truncate rounded border px-1 py-0.5 text-left text-2xs font-medium ${KIND_COLOUR[item.kind]}`}
                      >
                        {item.label}
                      </button>
                    ))}
                    {items.length > 3 && <p className="text-2xs text-ink-500">+{items.length - 3} more</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
