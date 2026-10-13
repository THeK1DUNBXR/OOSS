/**
 * The typed request layer. `api.ts` still owns the wire: the bearer header,
 * the one refresh on a 401, the sign-out and `ApiClientError`. This file only
 * states what each call returns, so a path or a shape that does not match the
 * shared type fails to typecheck where the call is written.
 *
 * The generic `get<T>(path)` is not a path check: any string compiles. The
 * guarantee belongs to `endpoints`, where the path and the response type are
 * written together once. A page that calls `get` directly is as typed as its
 * own generic, and no more.
 */

import type {
  CommandCenterResponse,
  CompanyProfileView,
  CourseView,
  DecisionView,
  FinalInvoiceDocumentView,
  FinalInvoiceView,
  GstFilingView,
  InvoiceDocumentView,
  InvoiceView,
  PaymentView,
  ReceiptDocumentView,
  ReceiptView,
  ReceivablesSummary,
} from '@kaizen/shared';
import { api } from './api.js';

/** A GET, returning the parsed body as `T`. The caller names `T`; the server's shape is not checked here. */
export function get<T>(path: string): Promise<T> {
  return api.get<T>(path);
}

/**
 * A POST. The body is passed through untouched: `undefined` sends no body, and
 * `{}` sends `'{}'`. A command with no fields still sends an empty object, and
 * a server that reads `req.body` depends on that difference.
 */
export function post<T, B = unknown>(path: string, body?: B): Promise<T> {
  return api.post<T>(path, body);
}

/** A PATCH. The body rule is the same as `post`. */
export function patch<T, B = unknown>(path: string, body?: B): Promise<T> {
  return api.patch<T>(path, body);
}

/** A DELETE. */
export function del<T>(path: string): Promise<T> {
  return api.del<T>(path);
}

/**
 * Typed endpoints, one object per domain. An entry exists only where a shared
 * response type in `packages/shared/src/api.ts` already names what the route
 * returns. Endpoints with no shared type are not invented here; the screen that
 * calls them keeps its own row type next to the call.
 *
 * Each path is the one the call sites used before, with no encoding added, so
 * a query key or URL built from these is byte-for-byte what it was.
 */
export const endpoints = {
  finance: {
    /** `GET /finance/invoices` — finance.routes.ts, inline mapping to `InvoiceView`. */
    invoices: () => get<InvoiceView[]>('/finance/invoices'),
    /** `GET /finance/invoices/:id/document` — invoicing.ts `invoiceDocument`. */
    invoiceDocument: (id: string) => get<InvoiceDocumentView>(`/finance/invoices/${id}/document`),
    /** `GET /finance/payments` — finance.routes.ts, inline mapping to `PaymentView`. */
    payments: () => get<PaymentView[]>('/finance/payments'),
    /** `GET /finance/receivables` — finance.routes.ts, inline mapping to `ReceivablesSummary`. */
    receivables: () => get<ReceivablesSummary[]>('/finance/receivables'),
    /** `GET /finance/receipts` — receipts.ts `listReceipts`. */
    receipts: () => get<ReceiptView[]>('/finance/receipts'),
    /** `GET /finance/receipts/:id/document` — receipts.ts `receiptDocument`. */
    receiptDocument: (id: string) => get<ReceiptDocumentView>(`/finance/receipts/${id}/document`),
    /** `GET /finance/final-invoices` — receipts.ts `listFinalInvoices`. */
    finalInvoices: () => get<FinalInvoiceView[]>('/finance/final-invoices'),
    /** `GET /finance/final-invoices/:id/document` — receipts.ts `finalInvoiceDocument`. */
    finalInvoiceDocument: (id: string) => get<FinalInvoiceDocumentView>(`/finance/final-invoices/${id}/document`),
  },
  books: {
    /** `GET /books/gst/filings` — books.routes.ts, inline mapping to `GstFilingView`. */
    gstFilings: () => get<GstFilingView[]>('/books/gst/filings'),
    /**
     * `GET /books/company-profile` — companyProfile.ts returns the stored row.
     * The view is the subset the screens read; the row carries more, which is harmless.
     */
    companyProfile: () => get<CompanyProfileView>('/books/company-profile'),
  },
  command: {
    /** `GET /command` — commandCenter.ts `commandCenter`. */
    centre: () => get<CommandCenterResponse>('/command'),
    /** `GET /command/decisions` — decisions.ts `decisionQueue`. */
    decisions: () => get<DecisionView[]>('/command/decisions'),
  },
  education: {
    /** `GET /education/courses` — courses.ts `listCourses`, with the default (retired excluded). */
    courses: () => get<CourseView[]>('/education/courses'),
  },
};
