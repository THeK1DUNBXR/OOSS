/**
 * The pieces every "add one" form is made of.
 *
 * The platform had 128 write endpoints and the interface reached 49 of them.
 * Screens listed records with no way to add one — you could not create an
 * invoice, a transaction, a customer or an employee from the interface, though
 * every endpoint existed and was tested. That is the kind of gap that makes a
 * product feel broken in a way no individual bug report captures.
 *
 * The cause was that each form was written from scratch, so each one was a
 * day's work and most were never written. These are the parts, so a new one is
 * twenty lines: a labelled control that shows its own error, and a modal that
 * owns the submit, the pending state and the failure message.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from './ui.js';

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function Label({ label, required, hint }: { label: string; required?: boolean; hint?: string }) {
  return (
    <span className="mb-1 flex items-baseline justify-between gap-2">
      <span className="label">
        {label}
        {required && <span className="ml-1 text-band-critical" aria-hidden>*</span>}
      </span>
      {hint && <span className="text-2xs text-ink-500">{hint}</span>}
    </span>
  );
}

export function TextInput({
  label, value, onChange, placeholder, required, hint, type = 'text', autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  type?: 'text' | 'email' | 'tel' | 'date' | 'number';
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <Label label={label} required={required} hint={hint} />
      <input
        className="input"
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export function MoneyInput({
  label, value, onChange, required, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  hint?: string;
}) {
  return (
    <label className="block">
      <Label label={label} required={required} hint={hint} />
      <div className="flex items-stretch">
        <span className="flex items-center rounded-l border border-r-0 border-ink-700 bg-ink-850 px-2 text-sm text-ink-400">₹</span>
        <input
          className="input rounded-l-none tabular-nums"
          type="number"
          min="0"
          step="0.01"
          value={value}
          required={required}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </label>
  );
}

export function SelectInput<T extends string>({
  label, value, onChange, options, required, hint, placeholder,
}: {
  label: string;
  value: T | '';
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  required?: boolean;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <Label label={label} required={required} hint={hint} />
      <select className="input" value={value} required={required} onChange={(e) => onChange(e.target.value as T)}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextArea({
  label, value, onChange, rows = 3, required, hint, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  required?: boolean;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <Label label={label} required={required} hint={hint} />
      <textarea
        className="input"
        rows={rows}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Two controls side by side, which is what most of these forms want. */
export function Row({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

/**
 * A create form that owns its own submit, pending state and failure message.
 *
 * The failure message matters more than it looks. These endpoints refuse things
 * for reasons a person can act on — a discount over the ceiling, a stage the
 * machine has no arrow for, a name that matches two employees — and the
 * refusal is written to be read. A form that swallowed it and showed
 * "Something went wrong" would be throwing away the most useful thing the API
 * produces.
 */
export function CreateModal({
  open,
  title,
  submitLabel = 'Create',
  onClose,
  onSubmit,
  invalidate,
  onCreated,
  children,
  width,
}: {
  open: boolean;
  title: string;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: () => Promise<unknown>;
  /** Query keys to refetch once it lands. */
  invalidate?: string[][];
  onCreated?: (result: unknown) => void;
  children: ReactNode;
  width?: string;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: onSubmit,
    onSuccess: (result) => {
      for (const key of invalidate ?? []) qc.invalidateQueries({ queryKey: key });
      setError(null);
      onCreated?.(result);
      onClose();
    },
    onError: (e: unknown) => setError(messageOf(e)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    mutation.mutate();
  };

  const close = () => {
    setError(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={close}
      width={width}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="create-form" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving…' : submitLabel}
          </button>
        </>
      }
    >
      <form id="create-form" onSubmit={submit} className="flex flex-col gap-3">
        {error && (
          <p className="rounded border-l-2 border-band-critical bg-band-critical/10 px-3 py-2 text-sm text-band-critical">
            {error}
          </p>
        )}
        {children}
      </form>
    </Modal>
  );
}

/**
 * The API's own words, where it gave any.
 *
 * Every refusal in this platform carries a sentence written for whoever hit it,
 * and the axis it failed on. Replacing that with a generic apology is how a
 * product ends up feeling arbitrary.
 */
export function messageOf(error: unknown): string {
  if (!error) return 'That did not work, and no reason was given.';
  const e = error as { message?: string; body?: { error?: { message?: string } } };
  return e.body?.error?.message ?? e.message ?? String(error);
}

/** The button that opens one of these, styled the same everywhere. */
export function NewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="btn-primary whitespace-nowrap" onClick={onClick}>
      <span aria-hidden className="mr-1">+</span>
      {label}
    </button>
  );
}
