/**
 * Getting started, and the tutorial.
 *
 * Two things on one screen, because they are the same question asked at
 * different times. On day one it is "what do I do first", and the checklist
 * answers it in order. A month later it is "how does this bit work", and the
 * walkthroughs answer that.
 *
 * The checklist is computed from the data — a step is done when the thing it
 * describes exists — so it cannot disagree with reality, and there is no
 * "mark as complete" button to lie with.
 *
 * The walkthroughs are written to be read rather than clicked through. A
 * spotlight tour that moves a highlight around the screen teaches somebody
 * where a button is; it does not teach them why leave balances are never
 * written directly, and that second thing is what makes this platform
 * behave the way it does.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { Card, EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui.js';

interface Step {
  key: string;
  title: string;
  why: string;
  done: boolean;
  count: number;
  path: string;
  /** Where the step is actually performed, when that is not just the screen. */
  doPath?: string;
  action: string;
  optional?: boolean;
}

interface State {
  steps: Step[];
  done: number;
  total: number;
  complete: boolean;
}

export default function Start() {
  const state = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api.get<State>('/auth/onboarding'),
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Getting started"
        subtitle="What to set up, in order, and how each part works."
      />
      <Checklist state={state} />
      <Walkthroughs />
    </div>
  );
}

function Checklist({ state }: { state: ReturnType<typeof useQuery<State>> }) {
  if (state.isLoading) return <Loading label="Checking what is set up" />;
  if (state.error) return <ErrorBox error={state.error} />;
  const data = state.data;
  if (!data) return null;

  if (data.steps.length === 0) {
    return (
      <Card title="Set up">
        <EmptyState
          message="Nothing here needs setting up by you."
          hint="Setting the company up is somebody else's job. Your screens are ready."
        />
      </Card>
    );
  }

  const required = data.steps.filter((s) => !s.optional);
  const optional = data.steps.filter((s) => s.optional);
  const next = required.find((s) => !s.done) ?? optional.find((s) => !s.done);

  return (
    <Card
      title={data.complete ? 'Set up' : 'Set up — start here'}
      subtitle={
        data.complete
          ? 'Everything a company needs to run is in place. The rest is optional.'
          : `${data.done} of ${data.total} done. Each step is ticked by the data itself, so it always says what is actually true.`
      }
    >
      <ol className="flex flex-col gap-px">
        {[...required, ...optional].map((step) => (
          <li
            key={step.key}
            className={`flex flex-wrap items-start gap-3 border-l-2 px-3 py-3 ${
              step.done
                ? 'border-band-healthy bg-band-healthy/5'
                : step === next
                  ? 'border-accent bg-accent/5'
                  : 'border-ink-800'
            }`}
          >
            <span
              aria-hidden
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-2xs ${
                step.done ? 'border-band-healthy text-band-healthy' : 'border-ink-600 text-ink-500'
              }`}
            >
              {step.done ? '✓' : ''}
            </span>

            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-2 text-sm font-semibold text-ink-100">
                {step.title}
                {step.optional && <span className="text-2xs font-normal text-ink-500">optional</span>}
                {step.done && (
                  <span className="text-2xs font-normal tabular-nums text-ink-500">
                    {step.count} on file
                  </span>
                )}
              </p>
              <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-400">{step.why}</p>
            </div>

            {/* Done: open the screen and look. Not done: go where the thing
                is actually done, which for a screen whose action is a dialog
                means opening the dialog too. */}
            <Link
              to={step.done ? step.path : (step.doPath ?? step.path)}
              className={step === next ? 'btn-primary' : 'btn'}
            >
              {step.done ? 'Open' : step.action}
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The walkthroughs
// ---------------------------------------------------------------------------

interface Topic {
  key: string;
  title: string;
  blurb: string;
  sections: Array<{ heading: string; body: string; link?: { to: string; label: string } }>;
}

const TOPICS: Topic[] = [
  {
    key: 'import',
    title: 'Bringing your data in',
    blurb: 'Tally, a bank statement or a spreadsheet — and how to undo it.',
    sections: [
      {
        heading: 'Drop the file in',
        body: 'The file is read and what it looks like is shown back to you. Correct it if it is wrong. You do not have to know what kind of export you made.',
        link: { to: '/data/import', label: 'Open Import' },
      },
      {
        heading: 'Nothing is saved until you say so',
        body: 'The preview lists every row that will be created and every row that will be skipped, with the reason. Rows already brought in are marked as duplicates.',
      },
      {
        heading: 'A Tally file names its own accounts',
        body: 'The Balance Sheet and P&L in the workbook say which side of the books each ledger belongs on, so the figures tie back to Tally exactly.',
      },
      {
        heading: 'Undo removes exactly what it added',
        body: 'Every row remembers the import that created it. Reverting deletes those rows and nothing else.',
      },
    ],
  },
  {
    key: 'money',
    title: 'The books',
    blurb: 'Where money sits, what it was for, and why nothing is edited.',
    sections: [
      {
        heading: 'An account is where money sits; a category is what it was for',
        body: 'Tally keeps both in one list. Here they are separate: the account says whether you can pay the rent, the category says what you spend on.',
        link: { to: '/finance/ledger', label: 'Open the Ledger' },
      },
      {
        heading: 'A mistake is reversed, not edited',
        body: 'Reverse posts the opposite entry and leaves both rows on screen. The history keeps showing what really happened.',
      },
      {
        heading: 'Every cost carries a division',
        body: 'Three businesses share one company. Without a division the dashboard cannot say which one is paying. The category suggests one; you can change it.',
        link: { to: '/business', label: 'See the division view' },
      },
      {
        heading: 'Capital is not revenue',
        body: 'Founder money moves the bank balance but stays out of the profit and loss.',
      },
    ],
  },
  {
    key: 'people',
    title: 'People',
    blurb: 'Why leave balances are never typed in, and what a pay rise takes.',
    sections: [
      {
        heading: 'A person, a seat, and the job they hold',
        body: 'The person is one record, the position another, and employment joins them. Leave, attendance, payroll and skills hang off the join.',
        link: { to: '/people/employees', label: 'Open Employees' },
      },
      {
        heading: 'A leave balance is never typed in',
        body: 'Approval holds days, completion settles them, cancellation gives them back. The balance is the sum. So "why 8.5 and not 11" has an answer on screen.',
        link: { to: '/people/leave', label: 'Open Leave' },
      },
      {
        heading: 'A pay rise takes two people',
        body: 'HR proposes and cannot approve. Finance approves and cannot propose. Nobody approves their own.',
      },
      {
        heading: 'Buttons match the record',
        body: 'A record only offers the steps it can actually take next, so a button never fails when you press it.',
      },
    ],
  },
  {
    key: 'access',
    title: 'Who can see what',
    blurb: 'Four roles, and why a screen differs from person to person.',
    sections: [
      {
        heading: 'Four roles',
        body: 'Employee: their own record, the staff directory, and invoices they raise. Operations Head: people, delivery and courses. Finance Head: the books, GST and pay approvals. Chairman: everything.',
        link: { to: '/admin/governance', label: 'See the matrix' },
      },
      {
        heading: 'Scope applies to reading too',
        body: 'Leave "at own scope" shows your leave, not the company\u2019s.',
      },
      {
        heading: 'A total needs wide enough access',
        body: 'Headcount and profit are statements about records you may not be able to open one by one, so they need company-wide access.',
      },
      {
        heading: 'The menu follows your access',
        body: 'A screen you cannot use is absent rather than greyed out.',
      },
    ],
  },
];

function Walkthroughs() {
  const [open, setOpen] = useState<string | null>(TOPICS[0].key);

  return (
    <Card title="How it works" subtitle="Four things worth ten minutes, once the data is in.">
      <div className="flex flex-col gap-px">
        {TOPICS.map((topic) => {
          const expanded = open === topic.key;
          return (
            <div key={topic.key} className="border-l-2 border-ink-800">
              <button
                className="flex w-full items-baseline justify-between gap-3 px-3 py-3 text-left hover:bg-ink-850"
                onClick={() => setOpen(expanded ? null : topic.key)}
                aria-expanded={expanded}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-100">{topic.title}</span>
                  <span className="block text-xs text-ink-400">{topic.blurb}</span>
                </span>
                <span aria-hidden className="text-ink-500">{expanded ? '−' : '+'}</span>
              </button>

              {expanded && (
                <div className="flex flex-col gap-4 px-3 pb-4 pt-1">
                  {topic.sections.map((section) => (
                    <section key={section.heading} className="max-w-2xl">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-300">
                        {section.heading}
                      </h3>
                      <p className="mt-1 text-sm leading-relaxed text-ink-400">{section.body}</p>
                      {section.link && (
                        <Link to={section.link.to} className="btn-quiet mt-2 inline-block">
                          {section.link.label} →
                        </Link>
                      )}
                    </section>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * The banner the rest of the app shows while setup is unfinished.
 *
 * It disappears on its own once the required steps are done, rather than
 * needing to be dismissed — a banner you have to close is a banner that was
 * not sure whether it was still true.
 *
 * There are two destinations here and therefore two links. The words say where
 * you are in the setup, so they lead to the checklist; the button is named
 * after one particular job — "Add a customer" — so it goes and does that job.
 * They used to be one link around the whole banner, which meant the button
 * took you to the checklist you were already being shown a line of, and the
 * first thing a new company pressed was the first thing that did not work.
 */
export function SetupBanner() {
  const { data } = useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api.get<State>('/auth/onboarding'),
    staleTime: 60_000,
  });

  if (!data || data.complete || data.steps.length === 0) return null;
  const next = data.steps.find((s) => !s.done && !s.optional);
  if (!next) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded border-l-2 border-accent bg-accent/5 px-4 py-3">
      <Link to="/start" className="min-w-0 transition-opacity hover:opacity-80">
        <span className="block text-sm font-semibold text-ink-100">
          Next: {next.title}
        </span>
        <span className="block text-xs text-ink-400">
          {data.done} of {data.total} set up. {next.why}
        </span>
      </Link>
      <Link to={next.doPath ?? next.path} className="btn-primary shrink-0">
        {next.action}
      </Link>
    </div>
  );
}
