/**
 * Portals its children onto a `#ki-print-root` div appended directly to
 * `<body>`, outside the app's own `#root` — so `@media print`'s
 * `body > *:not(#ki-print-root){display:none}` (see style.ts) can hide the
 * whole app shell the same way the reference tool hides everything but its
 * own print root, leaving only the invoice sheets on the printed page.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KI_PRINT_CSS } from './style.js';

let printStyleInjected = false;
function ensurePrintStyle() {
  if (printStyleInjected) return;
  const style = document.createElement('style');
  style.setAttribute('data-ki-print-style', 'true');
  style.textContent = KI_PRINT_CSS;
  document.head.appendChild(style);
  printStyleInjected = true;
}

function printRootEl(): HTMLElement {
  let el = document.getElementById('ki-print-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ki-print-root';
    document.body.appendChild(el);
  }
  return el;
}

export function PrintPortal({ children }: { children: ReactNode }) {
  const [container] = useState(printRootEl);

  // Only ever adds the stylesheet once; no cleanup here on purpose. The
  // container's children are React's own portal content — StrictMode mounts
  // and unmounts an effect twice to catch exactly this class of bug, and a
  // cleanup that reaches in and clears the container by hand fights the
  // portal for ownership of it and can leave it empty on the render that
  // matters. Nothing wants the container's node itself removed: the parent
  // simply stops rendering `PrintPortal` (and so stops portaling into it)
  // once there is nothing left to print.
  useEffect(() => {
    ensurePrintStyle();
  }, []);

  return createPortal(children, container);
}
