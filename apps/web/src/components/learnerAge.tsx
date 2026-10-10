import { ageInYears } from '@kaizen/shared';
import { Row, TextInput } from './forms.js';

/**
 * Whether the learner is an adult on the record: by the date of birth when one
 * is entered, otherwise by the staff member's attestation. Mirrors the server's
 * rule (assertMinorHasGuardian); the server has the final word. FX-64.
 */
export function adultOnRecord(dateOfBirth: string, adultAttested: boolean): boolean {
  const d = dateOfBirth ? new Date(dateOfBirth) : null;
  if (d && !Number.isNaN(d.getTime())) return (ageInYears(d) ?? 0) >= 18;
  return adultAttested;
}

export interface AgeBasisValues {
  dateOfBirth: string;
  adultAttested: boolean;
  guardianName: string;
  guardianPhone: string;
}

/** The age basis as the request body carries it. The attestation is sent only
 * when it is the thing deciding adulthood: a stated date of birth decides on its own. */
export function ageBasisBody(v: AgeBasisValues) {
  return {
    dateOfBirth: v.dateOfBirth || null,
    adultAttested: !v.dateOfBirth && v.adultAttested,
    guardianName: v.guardianName || null,
    guardianPhone: v.guardianPhone || null,
  };
}

/**
 * Date of birth, the adult attestation, and the guardian details the record
 * needs when the learner is not an adult on it. The attestation is unticked by
 * default: it is a staff member saying they have confirmed the age, and it is
 * recorded against them.
 */
export function AgeBasisFields({
  values,
  onChange,
}: {
  values: AgeBasisValues;
  onChange: (next: AgeBasisValues) => void;
}) {
  const guardianRequired = !adultOnRecord(values.dateOfBirth, values.adultAttested);
  const set = (patch: Partial<AgeBasisValues>) => onChange({ ...values, ...patch });
  return (
    <>
      <TextInput label="Date of birth" type="date" value={values.dateOfBirth} onChange={(dateOfBirth) => set({ dateOfBirth })} />
      {!values.dateOfBirth && (
        <label className="flex items-start gap-2 text-sm text-ink-200">
          <input
            type="checkbox"
            className="mt-1"
            checked={values.adultAttested}
            onChange={(e) => set({ adultAttested: e.target.checked })}
          />
          <span>
            I confirm this learner is 18 or over.
            <span className="block text-2xs text-ink-500">
              Tick this only if you have confirmed their age yourself. Your name is recorded against the enrolment.
              Without a date of birth and without this, a guardian's name and phone are required.
            </span>
          </span>
        </label>
      )}
      {guardianRequired && (
        <>
          <Row>
            <TextInput label="Guardian name" required value={values.guardianName} onChange={(guardianName) => set({ guardianName })} />
            <TextInput
              label="Guardian phone"
              required
              type="tel"
              value={values.guardianPhone}
              onChange={(guardianPhone) => set({ guardianPhone })}
            />
          </Row>
          <p className="text-2xs text-ink-500">
            A guardian is required for a learner under 18. Guardian contact is protected. Every look at it is recorded.
          </p>
        </>
      )}
    </>
  );
}
