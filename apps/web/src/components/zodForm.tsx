/**
 * The form kit for screens that validate with zod through react-hook-form.
 *
 * The controlled inputs in forms.tsx re-render the modal on every keystroke, and
 * each form checked its own rules only when the button was pressed. Here the
 * rules live in one schema, the error is shown beside the field it belongs to,
 * and the values that reach the submit have already been parsed.
 */

import { useId, type ReactNode } from 'react';
import { useForm, type DefaultValues, type UseFormRegisterReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { formatMinor, parseMinor } from '@kaizen/shared';

/**
 * A form whose values are checked by `schema` before the submit runs.
 *
 * `mode: 'onTouched'` checks a field when the person leaves it, so a mistyped
 * amount is named as they move on rather than after they have pressed the
 * button. After the first submit, RHF re-checks on change regardless of mode.
 */
export function useZodForm<S extends z.AnyZodObject>(schema: S, defaultValues: DefaultValues<z.input<S>>) {
  return useForm<z.input<S>, unknown, z.output<S>>({
    resolver: zodResolver(schema),
    defaultValues,
    mode: 'onTouched',
  });
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const NOT_A_RUPEE_AMOUNT = 'Enter an amount in rupees, such as 1250 or 1250.50';

/**
 * Thousands separators as a bank statement prints them: western 1,234,567 and
 * Indian 12,34,567 (lakh and crore). Only whole-rupee text that groups correctly
 * is ungrouped here. "1,2345" and "12,34.5" stay as typed, so parseMinor refuses
 * them: a stray comma is a typo, and guessing where it belonged would post a
 * figure nobody typed.
 */
const GROUPED_WHOLE_RUPEES = /^-?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$/;

/**
 * A money field: the text the person typed in, out as bigint paise.
 *
 * The parse is `parseMinor`, which refuses a third decimal rather than rounding
 * it. That refusal is the point: "1250.499" typed where a rupee amount was meant
 * is a unit mistake, and rounding it would hide the mistake in a posted figure.
 * Parsing inside the schema means no form can receive a float for money, and a
 * form that forgets to validate has nothing to send.
 */
export function moneyField({ positive = false, optional = false }: { positive?: boolean; optional?: boolean } = {}) {
  return z.string().transform((text, ctx): bigint => {
    const typed = text.trim();
    if (typed === '') {
      if (optional) return 0n;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount' });
      return z.NEVER;
    }
    let paise: bigint;
    try {
      paise = parseMinor(GROUPED_WHOLE_RUPEES.test(typed) ? typed.replace(/,/g, '') : typed);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: NOT_A_RUPEE_AMOUNT });
      return z.NEVER;
    }
    if (positive && paise <= 0n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter an amount above zero' });
      return z.NEVER;
    }
    if (!positive && paise < 0n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An amount cannot be negative' });
      return z.NEVER;
    }
    return paise;
  });
}

/**
 * The one place paise become a JSON number, because the Books routes still read
 * money as rupees in a JSON number (for example books.routes.ts `amount:
 * z.number().positive()` on POST /books/transactions). The number is built from
 * the exact two-place text `formatMinor` writes, so no arithmetic touches it.
 *
 * Delete this when those routes take the decimal string of paise that
 * cases.routes.ts already takes; until then every money field goes through here
 * and nowhere else.
 */
export function rupeesOnWire(paise: bigint): number {
  return Number(formatMinor(paise));
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

/**
 * A label bound to its control, with the hint and the error linked to it.
 *
 * The control is handed its ids through a render function rather than found by
 * cloning children, so the wiring is visible where the control is written. The
 * error is linked with aria-describedby and aria-invalid, so a screen reader
 * announces the problem when the person lands on the field, not only when they
 * have submitted and the message is somewhere else on the page.
 */
export function Field({
  label,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: (control: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="block">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="label">
          {label}
          {required && (
            <span className="ml-1 text-band-critical" aria-hidden>
              *
            </span>
          )}
        </label>
        {hint && (
          <span id={hintId} className="text-2xs text-ink-500">
            {hint}
          </span>
        )}
      </div>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error && (
        <p id={errorId} className="mt-1 text-sm text-band-critical">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A rupee amount typed as text.
 *
 * The input is text, not type="number": a number input reports an empty value
 * for a half-typed amount such as "1.2.3", so the person would be told the
 * field is blank when they had typed something. Text lets the parser name the
 * actual problem.
 */
export function MoneyField({
  label,
  field,
  error,
  hint,
  required,
}: {
  label: string;
  field: UseFormRegisterReturn;
  error?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <Field label={label} error={error} hint={hint} required={required}>
      {(control) => (
        <div className="flex items-stretch">
          <span
            aria-hidden
            className="flex items-center rounded-l border border-r-0 border-ink-700 bg-ink-850 px-2 text-sm text-ink-400"
          >
            ₹
          </span>
          <input
            {...field}
            {...control}
            className="input rounded-l-none tabular-nums"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            required={required}
          />
        </div>
      )}
    </Field>
  );
}

/**
 * The submit button, disabled while the save is in flight.
 *
 * Disabling is what stops a double click from sending the same create twice.
 */
export function SubmitButton({
  pending,
  idleLabel,
  pendingLabel = 'Saving…',
  form,
}: {
  pending: boolean;
  idleLabel: string;
  pendingLabel?: string;
  /** The id of a form elsewhere in the tree, for a button in a modal footer. */
  form?: string;
}) {
  return (
    <button type="submit" form={form} className="btn-primary" disabled={pending} aria-busy={pending || undefined}>
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}
