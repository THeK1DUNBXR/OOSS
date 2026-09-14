/**
 * Import endpoints.
 *
 * The upload takes the file as a raw body rather than as multipart. A browser
 * can `fetch(url, { method: 'POST', body: file })` directly, the server reads
 * the bytes without a parsing dependency, and there is no boundary-encoding
 * layer between the user's spreadsheet and the thing that reads it. The
 * filename rides along in a header because that is the only other thing
 * multipart was carrying.
 */

import { Router, raw } from 'express';
import { z } from 'zod';
import { handler } from '../lib/http.js';
import { ApiError } from '../platform/errors.js';
import {
  MAX_UPLOAD_BYTES, getImport, importRows, listImports,
  setImportOptions, setRowStatus, stageImport,
} from '../imports/service.js';
import { commitImport, revertImport } from '../imports/commit.js';
import type { ImportKind } from '../imports/detect.js';
import { TEMPLATES, buildTemplateWorkbook, listTemplates, templateBySlug } from '../imports/templates.js';

export const importsRouter = Router();

const KINDS: ImportKind[] = [
  'tally_ledger', 'bank_statement', 'employees', 'salary',
  'attendance', 'transactions', 'chart_of_accounts',
  'template_courses', 'template_batches', 'template_colleges', 'template_clients',
  'template_students', 'template_contacts', 'template_staff', 'template_opening_register',
];

/**
 * The blank files.
 *
 * Listed and downloaded without a grant check on `imports`, deliberately: a
 * template contains no company data, and making somebody hold an import
 * permission before they can see what the columns are is a way of ensuring the
 * spreadsheet arrives in the wrong shape. Signing in is enough. Uploading one
 * is where the permission belongs, and that is unchanged.
 */
importsRouter.get(
  '/templates',
  handler(async () => ({ items: listTemplates() })),
);

importsRouter.get(
  '/templates/:slug',
  handler(async (req, res) => {
    const spec = templateBySlug(req.params.slug);
    if (!spec) {
      throw ApiError.notFound(
        `No template called "${req.params.slug}". The ones there are: ${Object.keys(TEMPLATES).join(', ')}.`,
      );
    }
    const file = buildTemplateWorkbook(spec);
    res
      .status(200)
      .set({
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="kaizen-${spec.slug}-template.xlsx"`,
        'content-length': String(file.length),
        // A template changes only when the platform changes, and a stale one
        // uploads into the wrong columns. Not cached.
        'cache-control': 'no-store',
      })
      .send(file);
    return undefined;
  }),
);

importsRouter.post(
  '/',
  raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }),
  handler(async (req) => {
    const body = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw ApiError.badRequest(
        'No file arrived. Send the file as the request body, with its name in the X-File-Name header.',
      );
    }

    const fileName = String(req.header('x-file-name') ?? 'upload').slice(0, 200);
    const kindHeader = req.header('x-import-kind');
    const sheetHeader = req.header('x-import-sheet');

    if (kindHeader && !KINDS.includes(kindHeader as ImportKind)) {
      throw ApiError.badRequest(`"${kindHeader}" is not a kind of import. Expected one of: ${KINDS.join(', ')}.`);
    }

    return stageImport({
      fileName,
      buffer: body,
      kindOverride: kindHeader as ImportKind | undefined,
      sheetOverride: sheetHeader || undefined,
    });
  }),
);

importsRouter.get('/', handler(async () => listImports()));

importsRouter.get('/:id', handler(async (req) => getImport(req.params.id)));

importsRouter.get(
  '/:id/rows',
  handler(async (req) =>
    importRows(req.params.id, {
      status: req.query.status ? String(req.query.status) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }),
  ),
);

const optionsSchema = z.object({
  accountId: z.string().optional(),
  defaultCategoryId: z.string().optional(),
  defaultDivision: z.enum(['software', 'skill', 'education', 'shared']).optional(),
  fallbackAccountName: z.string().optional(),
});

importsRouter.patch(
  '/:id/options',
  handler(async (req) => setImportOptions(req.params.id, optionsSchema.parse(req.body))),
);

importsRouter.patch(
  '/rows/:rowId',
  handler(async (req) => {
    const { status } = z.object({ status: z.enum(['ready', 'skipped']) }).parse(req.body);
    return setRowStatus(req.params.rowId, status);
  }),
);

importsRouter.post('/:id/commit', handler(async (req) => commitImport(req.params.id)));

importsRouter.post('/:id/revert', handler(async (req) => revertImport(req.params.id)));
