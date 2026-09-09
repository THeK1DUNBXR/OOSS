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
        subtitle="What to set up, in the order that makes each step useful, and how the parts work once they are."
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
          hint="Setting the company up is the Chairman's and the Finance Head's job. Your own screens are ready to use."
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

            <Link to={step.path} className={step === next ? 'btn-primary' : 'btn'}>
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
    blurb: 'Tally, a bank statement, or a spreadsheet — and how to undo it if it goes wrong.',
    sections: [
      {
        heading: 'Drop the file in and read what it says',
        body:
          'The file is inspected and what it appears to be is shown as a claim you can correct — "a Tally ledger report, 66 accounts, each with dated vouchers beneath it". You are not asked to classify your own export before seeing anything, because most people exporting from Tally do not know whether they produced a Day Book or a Ledger Voucher report, and it does not matter: the platform can tell.',
        link: { to: '/data/import', label: 'Open Import' },
      },
      {
        heading: 'Nothing is written until you say so',
        body:
          'The preview shows every row that will be created and every row that will not, with the reason. Rows already brought in on an earlier file are marked as duplicates and left alone, so re-importing a statement that overlaps last month’s does not double anything.',
      },
      {
        heading: 'A Tally export carries its own chart of accounts',
        body:
          'Alongside the vouchers, a Tally workbook holds a Balance Sheet and a Profit & Loss, and between them they name every ledger and say which side of the books it belongs on. The platform reads that rather than guessing from names — which is how it knows "Bank Charges" is a cost and not a bank account, and why the imported figures tie back to Tally exactly.',
      },
      {
        heading: 'Undo removes exactly what it added',
        body:
          'Every row records what it created. Reverting an import deletes those records and nothing else, so a first attempt at a year of books is a decision you can take back in one click rather than a weekend of manual correction.',
      },
    ],
  },
  {
    key: 'money',
    title: 'The books',
    blurb: 'Where money sits, what it was for, and why nothing here is ever edited.',
    sections: [
      {
        heading: 'An account is where money sits; a category is what it was for',
        body:
          'Tally keeps both in one flat list of "ledgers". Here they are separate, because they answer different questions: the account tells you whether you can pay the rent, and the category tells you what you are spending it on.',
        link: { to: '/finance/ledger', label: 'Open the Ledger' },
      },
      {
        heading: 'A mistake is reversed, never edited',
        body:
          'A transaction has no edit control — only Reverse, which posts the opposite entry and leaves both rows on screen with the reversed one struck through. That is not bureaucracy: a bank line already matched against the original keeps matching it, and the history keeps showing what really happened.',
      },
      {
        heading: 'Every cost carries a division',
        body:
          'Three businesses run inside one legal entity, and a consolidated total hides which of them is paying for the others. A transaction with no division cannot answer the question the dashboard exists to answer, so the category suggests one and you can override it per entry.',
        link: { to: '/business', label: 'See the division view' },
      },
      {
        heading: 'Capital is not revenue',
        body:
          'Money the founders put in moves the bank balance and is not trading performance. It counts in the cash position and is excluded from the profit and loss — otherwise the month the funding landed would read as the best month the company ever had.',
      },
    ],
  },
  {
    key: 'people',
    title: 'People',
    blurb: 'Why leave balances are never typed in, and what a pay rise takes.',
    sections: [
      {
        heading: 'A person, a seat, and the relationship between them',
        body:
          'Somebody on the staff list is a person. The job they do is a position. The employment relationship joins the two, and leave, attendance, payroll and skills all hang off it. That is why importing a staff list creates all three rather than just a list of names.',
        link: { to: '/people/employees', label: 'Open Employees' },
      },
      {
        heading: 'A leave balance is never written directly',
        body:
          'Approval places a hold, completion settles it, cancellation reverses it, and the balance is the sum of its own ledger. That is what makes "why is it 8.5 and not 11" a question with an answer you can read off the screen.',
        link: { to: '/people/leave', label: 'Open Leave' },
      },
      {
        heading: 'A pay rise takes two people',
        body:
          'HR proposes compensation and holds no approval. Finance approves and can neither create nor edit the proposal, so the signatory is never the author. Neither can move a salary alone, and nobody at all can approve their own — not even the Chairman.',
      },
      {
        heading: 'Buttons come from the state machine',
        body:
          'Every record shows only the transitions its lifecycle actually allows from where it stands, computed by the same machine the API enforces against. A payroll run sitting at Computed offers "Submit review" and nothing else, because that is the only arrow out of Computed — so a button can never offer something that will be refused.',
      },
    ],
  },
  {
    key: 'access',
    title: 'Who can see what',
    blurb: 'Four roles, and why the same screen shows different things to different people.',
    sections: [
      {
        heading: 'Four roles, and that is the whole model',
        body:
          'Employee sees their own record and the staff directory. HR & Operations Manager runs the people function and delivery. Finance Head holds the books and approves the money side of people. Chairman is superadmin — every resource, every verb, nothing hidden.',
        link: { to: '/admin/governance', label: 'See the matrix' },
      },
      {
        heading: 'Scope is real, including on reads',
        body:
          'An employee holding leave "at own scope" gets their own leave ledger, not the company’s — the narrowing applies to reading as much as to writing. Where a read genuinely should reach everything, the matrix says so explicitly rather than relying on a rule you would have to know about.',
      },
      {
        heading: 'A total needs a grant wide enough to produce it',
        body:
          'A headcount or a profit figure is a statement about records you may not be allowed to see one by one. Those need an all-scope grant, because a narrowed one cannot produce a total that means anything.',
      },
      {
        heading: 'Navigation is a projection of your grants',
        body:
          'Screens you hold no grant on are absent from the sidebar rather than greyed out. If you cannot see the Ledger, it is not there — which is a clearer statement than a disabled link you can never enable.',
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
    <Link
      to="/start"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded border-l-2 border-accent bg-accent/5 px-4 py-3 transition-colors hover:bg-accent/10"
    >
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink-100">
          Next: {next.title}
        </span>
        <span className="block text-xs text-ink-400">
          {data.done} of {data.total} set up. {next.why}
        </span>
      </span>
      <span className="btn-primary shrink-0">{next.action}</span>
    </Link>
  );
}
