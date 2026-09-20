/**
 * H_MKT domain health, reused at the top of Marketing Analytics.
 *
 * There is no per-domain health endpoint — the Command Center reads the same
 * `/command` payload and picks its tile out of the ten-domain `pulse` array,
 * so this card does the same rather than standing up a second computation
 * that could drift from the one true score. A domain the platform has not
 * measured yet says so; it never shows a bare zero.
 */

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { CommandCenterResponse } from '@kaizen/shared';
import { api } from '../../lib/api.js';
import { NOT_MEASURED, domainAsks, domainName } from '../../lib/words.js';
import { BandChip, Card, ContributionBar, Loading } from '../../components/ui.js';

export function MarketingHealthCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['command-center', 'for-marketing-health'],
    queryFn: () => api.get<CommandCenterResponse>('/command'),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <Card title="Marketing health" className="mb-5">
        <Loading label="Loading" />
      </Card>
    );
  }

  // The health domain read is a bonus panel on this page, not the reason for
  // it — a viewer without command-center grants still gets the rest of
  // Analytics, just without this card.
  const health = data?.pulse.find((p) => p.domainCode === 'H_MKT');
  if (!health) return null;

  return (
    <Card
      title={domainName(health.domainCode, health.domainName)}
      subtitle={domainAsks(health.domainCode)}
      actions={
        <Link to={health.drillPath} className="text-2xs text-accent-soft hover:underline">
          Open in Command Center →
        </Link>
      }
      className="mb-5"
    >
      {health.state !== 'measured' ? (
        <p className="text-sm italic text-ink-500">{NOT_MEASURED}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[auto,1fr]">
          <div className="flex shrink-0 items-center gap-3">
            <p className="text-3xl font-semibold tabular-nums text-ink-50">{health.score?.toFixed(1)}</p>
            <div>
              <BandChip band={health.band} />
              {health.distanceToEdge !== null && (
                <p className="mt-1 text-2xs text-ink-500">{health.distanceToEdge.toFixed(0)} points of room</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {health.factors.map((f) => (
              <div key={f.factor} className="flex items-center gap-3">
                <span className="w-56 shrink-0 truncate text-2xs text-ink-300" title={f.narrative}>
                  {f.label}
                </span>
                <div className="min-w-0 flex-1">
                  <ContributionBar
                    value={f.contribution}
                    max={f.weight}
                    tone={f.contribution / f.weight < 0.4 ? 'bad' : f.contribution / f.weight < 0.7 ? 'warn' : 'accent'}
                  />
                </div>
                <Link to={f.drillPath} className="w-6 shrink-0 text-right text-2xs text-accent-soft hover:underline" title="Open source records">
                  →
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
