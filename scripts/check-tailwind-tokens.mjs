/**
 * Every Tailwind colour token used in the client is one the config defines.
 *
 * Tailwind drops a class it does not recognise. It does not warn, it does not
 * fail the build, and the element simply renders without the style. That is how
 * `border-band-healthy`, `bg-band-healthy/5` and `text-band-healthy` shipped on
 * the getting-started checklist (`Start.tsx`) and `border-band-good/40` /
 * `text-band-good` on the employee chips (`People.tsx`): the palette defines
 * `band.strong|stable|watch|strained|critical` and has never had a `healthy` or
 * a `good`. The ticks and the chips have been colourless for two releases and
 * nothing anywhere said so.
 *
 * The plan asks for `eslint-plugin-tailwindcss` with `no-custom-classname`.
 * That plugin cannot load under this workspace's pnpm layout — its resolver
 * throws `Could not resolve tailwindcss` even though `require.resolve` finds it
 * from both the root and `apps/web`. Rather than pin a resolver workaround, the
 * check is done here: narrower than the plugin, but it catches precisely the
 * class of bug that has actually cost this project something, it needs no
 * dependency, and it runs in milliseconds.
 *
 *   node scripts/check-tailwind-tokens.mjs          # report
 *   node scripts/check-tailwind-tokens.mjs --check  # exit 1 on any unknown token
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'apps/web/src');

/** Utility prefixes that take a colour token. */
const COLOUR_PREFIXES = [
  'bg', 'text', 'border', 'ring', 'fill', 'stroke', 'divide', 'outline',
  'from', 'via', 'to', 'accent', 'caret', 'shadow', 'decoration', 'placeholder',
];

/** Tailwind's own palette names, which need no entry in the config. */
const BUILTIN = new Set([
  'inherit', 'current', 'transparent', 'black', 'white',
  'slate', 'gray', 'grey', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber',
  'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo',
  'violet', 'purple', 'fuchsia', 'pink', 'rose',
]);

/**
 * Non-colour utilities that collide with a colour prefix — `text-sm` is a size,
 * `border-2` a width, `shadow-lg` a shadow. Matching them as colours would
 * produce noise, and noise is how a check gets switched off.
 */
const NOT_A_COLOUR = new Set([
  'xs', '2xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl',
  'left', 'right', 'center', 'justify', 'start', 'end', 'top', 'bottom',
  'solid', 'dashed', 'dotted', 'double', 'none', 'hidden', 'collapse', 'separate',
  'wrap', 'nowrap', 'balance', 'pretty', 'clip', 'ellipsis', 'wide', 'wider', 'tight',
  'auto', 'full', 'screen', 'min', 'max', 'fit', 'px', 'opacity', 'inner',
  'thin', 'medium', 'bold', 'semibold', 'extrabold', 'black', 'light', 'normal',
]);

function loadPalette() {
  // The config is CJS with a `module.exports`; read it rather than import it so
  // this script stays free of the bundler's resolution rules.
  const src = readFileSync(join(ROOT, 'apps/web/tailwind.config.js'), 'utf8');
  const names = new Set();
  // Top-level colour families: `band: {`, `ink: {`, `accent: {` …
  const colorsBlock = src.slice(src.indexOf('colors:'));
  for (const m of colorsBlock.matchAll(/^\s{6,10}([a-zA-Z][\w-]*)\s*:/gm)) names.add(m[1]);
  // Each family's shades, so `band-strong` and `ink-850` resolve.
  const full = new Set(names);
  for (const family of names) {
    const block = new RegExp(`${family}\\s*:\\s*\\{([^}]*)\\}`, 's').exec(colorsBlock);
    if (!block) continue;
    for (const m of block[1].matchAll(/([a-zA-Z0-9][\w-]*)\s*:/g)) {
      full.add(m[1] === 'DEFAULT' ? family : `${family}-${m[1]}`);
    }
  }
  return full;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const palette = loadPalette();
const findings = [];

for (const file of walk(WEB)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(
      new RegExp(`\\b(?:hover:|focus:|active:|disabled:|group-hover:|focus-visible:|dark:|sm:|md:|lg:|xl:)*(${COLOUR_PREFIXES.join('|')})-([a-zA-Z][\\w-]*)(?:\\/\\d+)?\\b`, 'g'),
    )) {
      const [, prefix, token] = m;
      if (NOT_A_COLOUR.has(token)) continue;
      const family = token.split('-')[0];
      if (BUILTIN.has(family)) continue;
      // Only families the config actually declares are our business; anything
      // else is a utility this crude matcher mistook for a colour.
      if (!palette.has(family)) continue;
      if (palette.has(token)) continue;
      findings.push({ file: relative(ROOT, file), line: i + 1, cls: `${prefix}-${token}` });
    }
  });
}

if (findings.length) {
  console.error(`\n${findings.length} Tailwind class${findings.length === 1 ? '' : 'es'} using a token the palette does not define:\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.cls}`);
  console.error('\nTailwind drops these silently — the element renders unstyled.');
  console.error('Define the token in apps/web/tailwind.config.js, or use one that exists.\n');
  if (process.argv.includes('--check')) process.exit(1);
} else {
  console.log(`Tailwind tokens: all known (${palette.size} defined).`);
}
