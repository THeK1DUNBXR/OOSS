> One phase per session. Read only this file plus `CLAUDE.md`. `README.md` has the audit point and the known line-number drift.

# PHASE 4 — The interface

**Duration:** four to six weeks. **Gate:** zero axe-core violations, Lighthouse accessibility ≥ 95, full invoice flow usable at 390px.

## 4.1 Foundations

- **Code splitting.** `apps/web/src/main.tsx:7-33` static-imports 25 page modules, one of which (`pages/Executive.tsx:37`) pulls in Recharts, so it is all in the first-paint bundle; `grep -rn "lazy(\|Suspense"` returns **zero**. Convert every route to `React.lazy` with a `Suspense` boundary. First paint currently pays for `PeopleOps.tsx` (1,537 lines), `Admin.tsx` (1,145) and ~500KB of Recharts on the login screen.
- **Error boundaries.** There are none. One render throw blanks the application. Add a root boundary and a per-route boundary that reports to the logging backend with the `requestId`.
- **401 handling.** `apps/web/src/lib/api.ts` has **no 401-specific branch at all** — every non-OK response throws through the same generic path at `:70`, and only the mount-time `refresh()` (`lib/session.tsx:51-67`) clears the token, so a mid-session expiry produces a screen of red error boxes with no path back to login. Add an interceptor that attempts a refresh, then redirects.
- **Token storage.** Move off `localStorage` (`api.ts:9`, `TOKEN_KEY = 'kaizen.token'`) to an httpOnly cookie with the refresh flow from Phase 0.2, or accept the XSS exposure explicitly and write down why.
- **Typed client.** Generate one from the API — `packages/shared/src/api.ts` already holds 1,351 lines of exact response types and the frontend bypasses them at **38 `api.get<any…>` call sites**, with `any` used freely across `pages/`, `components/` and `lib/` — a word-boundary grep returns 114 hits, of which **97 are genuine TypeScript `any` annotations** (`<any`, `: any`, `as any`) and the rest are the English word in prose. Generate an OpenAPI document from the Zod route schemas, generate a client from it, and make `any` a lint error in `apps/web`.

## 4.2 The design system

There is a real, reasoned token file at `apps/web/tailwind.config.js` (91 lines) — an accessibility-validated categorical palette for the four divisions at `:59-63` with a documented ΔE 7.4 protanopia caveat and a stated mitigation, flat-by-decision with `boxShadow: { none: 'none' }` at `:86`, hierarchy carried by 1–3px ink borders. The `band` tokens are at `:39-41`; `accent.deep` at `:36` is defined and never used. **Keep all of it.** What is missing is components.

`components/ui.tsx` is 331 lines exporting 16 primitives, with **no Table, no Button, no Dropdown, no DatePicker, no Toast, no Pagination, no Combobox, no Drawer, no Tooltip**. Buttons are raw `<button className="btn-primary">`. Tables are **69 hand-written `<table>` blocks across 18 files.**

Build, in `packages/ui`:

- **`DataTable`** — the single highest-leverage component in this plan. Column definitions, server-driven sorting and filtering, cursor pagination, row virtualisation, column visibility, CSV export, sticky header, a totals row, an empty state, and a loading skeleton. Then delete all 69 hand-rolled tables. Seven call sites across five files use hardcoded magic limits (`?limit=200` in `Import.tsx:353` and `invoiceEditor.tsx:179`; `?limit=150`, `?limit=120` and `?limit=40` in `Admin.tsx:898,659,773`; `?limit=80` in `People.tsx:432`; `?limit=10` in `Commercial.tsx:679`) and the rest fetch unbounded lists and render every row.
- `Button`, `Input`, `Select`, `Combobox`, `DatePicker` (IST-aware, with financial-year shortcuts), `Modal` (with `role="dialog"`, `aria-modal`, focus trap, focus restore, Escape and backdrop close — the current one at `ui.tsx:290` has none of these), `Drawer`, `Toast`, `Tooltip`, `Popover`, a rewrite of the existing `Tabs` (`ui.tsx:252`) with `role="tablist"`, and `CommandPalette` with arrow-key navigation and `role="listbox"` (the current ⌘K at `Shell.tsx:357` is mouse-only).
- **Preserve the two things that are genuinely excellent:** the `not-measured ≠ zero ≠ withheld` triad (`ui.tsx:189-200`) and `ErrorBox` rendering the server's five-axis denial trace by mapping `axes[]` and colouring each one (`ui.tsx:212-224`). Those are product principles enforced in code and most ERPs have neither.

## 4.2a Make the `Metric` rule real

The first audit claimed `Metric` structurally requires `drillTo` or `noActionReason`. **It does not.** Both are plain optionals (`ui.tsx:147-148`), there is no discriminated union and no runtime check, and the component renders unwrapped when `drillTo` is absent (`:167-173`). What exists is a doc comment at `ui.tsx:132-135` stating the intent: *"drillTo is required unless noActionReason explains why none exists — a dead number is a defect, not a layout choice."*

**52 of 90 call sites — 57% — pass neither**, including every figure on the GST return screens (`pages/GstReturns.tsx:350-353,569-571`), the receipt and final-invoice document headers (`ReceiptDocument.tsx:206,207`, `FinalInvoiceDocument.tsx:273,274`) and `Courses.tsx:82,83`.

So build the property:

1. Change `MetricProps` to a discriminated union — `{ drillTo: string } | { noActionReason: string }` — so omitting both is a type error. Do this first, so the compiler produces the worklist.
2. Walk all 52 violations. Each one gets a real drill target, or a `noActionReason` that says something true. **"No drill available" is not a reason; "this figure is the document's own total, there is nothing beneath it" is.** The document headers (receipt, final invoice) are the legitimate `noActionReason` cases; the GST return figures are not — every one of them has a supporting document list behind it and should drill to it.
3. Add a lint rule or a test asserting no `<Metric>` in the codebase carries neither, so the property cannot decay.

This is a prerequisite for §6.3, which builds the Briefing on the assumption that a number without a drill path cannot exist.

Replace the bespoke form code. `createForms.tsx` is **1,898 lines for 23 hand-written forms**, averaging 82 lines each, with `required` on the DOM input as the only client-side validation. Move to `react-hook-form` + the shared Zod schemas, so the client validates against the exact schema the server enforces.

## 4.3 Accessibility

Across ~19,000 lines there are **11 `aria-*` attributes** (seven `aria-hidden`, two `aria-label`, two `aria-expanded`), **no ARIA `role=` anywhere** (the single grep hit — `createForms.tsx:881` at the audit point, `:878` on the current branch — is a `role=sponsor` URL query parameter), **zero `tabIndex`**, **zero `focus-visible`**. An ERP is precisely the class of software that gets blocked in procurement on WCAG.

Target WCAG 2.1 AA: focus management and visible focus rings (the `.input` focus state currently changes border width from 1.5px to 2px and nothing else), keyboard operation of every interaction, semantic landmarks, live regions for async results, and `axe-core` in CI failing the build on any violation.

## 4.4 Mobile

**98 responsive utilities across the entire application, spread over 25 files**, and `Shell.tsx`, `components/ui.tsx`, `pages/Pipeline.tsx`, `pages/Start.tsx`, `pages/InvoiceDocument.tsx` and `pages/documentSheet.tsx` have zero. The sidebar is a permanent 224px column at every viewport. The only mobile accommodation in the product is `overflow-x-auto` — 38 occurrences across 15 files.

The README's own motivating scenario is a field person enrolling a walk-in student. They cannot do it from a phone.

Build mobile-first for the surfaces that are actually used in the field: enrolment, receipt capture, attendance, expense capture with a camera, approvals, and the Briefing. Add a service worker and IndexedDB queue so those specific surfaces capture offline and sync — there is currently no service worker, no manifest, no `navigator.onLine` and no cache persistence anywhere.

## 4.5 Feel

Skeletons instead of the full-panel spinner swap (`ui.tsx:201` + `staleTime: 15_000` in `main.tsx:37` means most navigations flash). Optimistic updates via `onMutate` / `setQueryData` — there are currently **zero**; every mutation round-trips then invalidates then refetches. Toasts — there are currently **zero**, so a successful mutation gives no confirmation at all; the modal just closes. Prefetch on hover. Route transitions.

## 4.6 Frontend tests

There are none. Add Vitest + Testing Library for components, Playwright for flows. The existing e2e suite is one 134-line spec covering the getting-started checklist's link targets; invoicing, GST filing, payroll and imports have no browser coverage whatsoever. Add visual regression on the document surfaces — invoice, receipt, payslip — because those are printed and sent to customers.
