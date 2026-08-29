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
    body:
      'It is built around what needs you today — your work, anything overdue, and anything the system has already handled without asking. If you only ever open one screen, open that one.',
  },
  {
    heading: 'Every number opens up',
    body:
      'Click a score and it breaks into the things driving it. Click one of those and you reach the actual records. No figure here is something you have to take on trust.',
  },
  {
    heading: '“Nothing to measure yet” is not zero',
    body:
      'Where there is not enough information, the system says so rather than showing a zero. A zero would tell you things are going badly, which is different from not knowing.',
  },
  {
    heading: 'You see what your job needs',
    body:
      'Menus and figures differ from person to person. Something you cannot act on is simply absent rather than greyed out — so what you see is what you can actually do.',
  },
  {
    heading: 'Nothing is quietly deleted',
    body:
      'Corrections are added rather than written over. A payment entered by mistake is reversed with a new entry, so the history always shows what really happened.',
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
