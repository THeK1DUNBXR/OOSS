/**
 * Recognising that two spellings are the same person.
 *
 * The same twelve people appear across these files as "Thamimshah" and "Thamim
 * Shah", "Vasanth Kumar" and "Vasantha Kumar G", "Seenivasan" and "Seenivasan
 * S.R.". A salary sheet that refuses nine of twelve rows because the payroll
 * clerk types names differently from whoever keeps the staff list is not a
 * working importer.
 *
 * The rule throughout is that a confident match is taken and an ambiguous one
 * is refused with both candidates named. Silently attaching somebody's salary
 * to the wrong employee is far worse than making a person look at two rows,
 * and there is no amount of cleverness here that justifies the risk.
 */

export interface Candidate {
  id: string;
  fullName: string;
}

export type MatchResult =
  | { kind: 'matched'; id: string; how: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; names: string[] };

/** Word tokens, lowercased, initials and honorifics dropped. */
function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Every letter, in order, with nothing between. */
function squash(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * The order-insensitive form. "Shah Thamim" and "Thamim Shah" agree here, and
 * this is what an exact match means for a name.
 */
export function normaliseName(name: string): string {
  return tokens(name).sort().join(' ');
}

/**
 * Whether every token of the shorter name is accounted for in the longer.
 *
 * A token counts as accounted for when it equals another token or is a prefix
 * of one — which is what makes "Vasanth" and "Vasantha" the same person, and
 * "Kumar" and "Kumaravel" the same one too. At least two tokens must agree, or
 * one token that is the whole of both names, so "Kumar" alone never matches
 * "Kumar Selvam".
 */
function tokensAgree(a: string[], b: string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 0) return false;

  let agreed = 0;
  const used = new Set<number>();
  for (const token of short) {
    const index = long.findIndex(
      (other, i) => !used.has(i) && (other === token || other.startsWith(token) || token.startsWith(other)),
    );
    if (index === -1) return false;
    used.add(index);
    agreed += 1;
  }

  return agreed >= 2 || (short.length === 1 && long.length === 1);
}

/**
 * Finds the person a name in a file refers to.
 *
 * Stages run widest-first and stop at the first that produces exactly one
 * candidate, so an exact match is never displaced by a fuzzy one.
 */
export function matchPerson(name: string, candidates: Candidate[]): MatchResult {
  const wanted = normaliseName(name);
  const wantedSquashed = squash(name);
  const wantedTokens = tokens(name);

  const stages: Array<{ how: string; test: (c: Candidate) => boolean }> = [
    { how: 'the same name', test: (c) => normaliseName(c.fullName) === wanted },
    // "Thamimshah" and "Thamim Shah": the same letters, spaced differently.
    { how: 'the same name spelled without the space', test: (c) => squash(c.fullName) === wantedSquashed },
    // "Vasanth Kumar" and "Vasantha Kumar G": every word accounted for.
    { how: 'every part of the name accounted for', test: (c) => tokensAgree(wantedTokens, tokens(c.fullName)) },
  ];

  for (const stage of stages) {
    const hits = candidates.filter(stage.test);
    if (hits.length === 1) return { kind: 'matched', id: hits[0].id, how: stage.how };
    if (hits.length > 1) return { kind: 'ambiguous', names: hits.map((h) => h.fullName) };
  }

  return { kind: 'none' };
}

/** The message a failed match should produce, phrased for whoever is importing. */
export function matchFailure(name: string, result: MatchResult): string {
  if (result.kind === 'ambiguous') {
    return `"${name}" could be ${result.names.join(' or ')}. Make the name in the file match one of them exactly, so this does not have to be guessed.`;
  }
  return `Nobody on the staff list matches "${name}". Import the staff list first, or correct the spelling in the file.`;
}
