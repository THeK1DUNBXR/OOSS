/**
 * A short orientation, shown once.
 *
 * Everything it says is a claim a new user can check on screen within a
 * minute — the point is to make the first five minutes make sense, not to
 * summarise the architecture. It dismisses permanently and never reappears.
 */

import { useState } from 'react';
import { Modal } from './ui.js';

const KEY = 'kaizen.seenIntro';

function alreadySeen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true; // A private window should not be nagged on every load.
  }
}

const POINTS: Array<{ heading: string; body: string }> = [
  {
    heading: 'Start with the first screen in the sidebar',
    body: 'It shows what needs you today: your work, anything overdue, and anything already handled for you.',
  },
  {
    heading: 'Every number opens up',
    body: 'Click a figure to see what it is made of, and again to reach the records behind it.',
  },
  {
    heading: '\u201CNothing to measure yet\u201D is not zero',
    body: 'When there is too little information, it says so instead of showing a zero.',
  },
  {
    heading: 'You see what your job needs',
    body: 'Anything you cannot use is absent rather than greyed out.',
  },
  {
    heading: 'Nothing is quietly deleted',
    body: 'A mistake is corrected by a new entry, so the history still shows what happened.',
  },
];

export function FirstRun() {
  const [open, setOpen] = useState(() => !alreadySeen());

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* nothing to remember it with; closing is still correct */
    }
    setOpen(false);
  };

  return (
    <Modal
      open={open}
      title="A minute before you start"
      onClose={dismiss}
      width="max-w-2xl"
      footer={
        <button className="btn-primary" onClick={dismiss}>
          Got it
        </button>
      }
    >
      <div className="space-y-3">
        {POINTS.map((p) => (
          <div key={p.heading} className="rounded-lg border border-ink-800 bg-ink-950 p-3">
            <p className="text-xs font-medium text-ink-100">{p.heading}</p>
            <p className="mt-1 text-2xs leading-relaxed text-ink-400">{p.body}</p>
          </div>
        ))}
        <p className="px-1 text-2xs text-ink-500">
          You will not see this again. Everything in it is visible on screen anyway.
        </p>
      </div>
    </Modal>
  );
}
