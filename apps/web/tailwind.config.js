/**
 * The Kaizen Infinities design system.
 *
 * Fluent, Apple-esque, minimalist — depth carries hierarchy, not border
 * weight. Every structural line lightens to a whisper; what used to be a
 * 1px/2px/3px border ladder is now a resting/raised/floating elevation
 * ladder (`shadow.soft/raised/floating/glass` below), each a real
 * dual-layer shadow, never a flat colored offset. Glass (translucency +
 * backdrop-blur) is reserved for chrome that genuinely floats over content
 * — modals, dropdowns, popovers — where blur has something behind it to
 * blur; it is a material, not a decoration sprinkled on static panels.
 *
 * The `ink` scale still runs the direction it did when this app was dark —
 * 950 is the page, 100 is the strongest text — so every existing utility
 * keeps its meaning. Only the border/hairline steps (800/700) were
 * softened; text and surface values are unchanged.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#F2F2F4', // the page itself
          925: '#F8F8F9', // between the page and a raised surface
          900: '#ffffff', // a surface raised off the page
          850: '#F2F2F4', // a hovered or recessed surface
          800: '#e7e7eb', // hairline — a whisper, not a rule
          700: '#d7d7dd', // border, softened
          600: '#a9a9b4', // border, emphatic
          500: '#6b6b74', // muted text
          400: '#57575f', // secondary text
          300: '#3A3A45',
          200: '#3A3A45', // body text
          100: '#0F0F12', // primary text
          50: '#0F0F12',
        },
        // The accent is ink: primary actions are black on paper, and gold is
        // what they turn when you touch them. Gold never carries body text —
        // #FFC20E on paper fails contrast — so `soft` is the gold you can read.
        accent: { DEFAULT: '#0F0F12', soft: '#8a6a00', deep: '#FFC20E' },
        gold: { DEFAULT: '#FFC20E', soft: '#FFF3CE', deep: '#8a6a00' },
        paper: { DEFAULT: '#F2F2F4', surface: '#ffffff' },
        band: {
          strong: '#1a7a4c', stable: '#3d8f68', watch: '#b5570c',
          strained: '#a8481a', critical: '#ad2c22',
          // Aliases for the plain good/warn/bad vocabulary several screens
          // reach for instead of the five-step scale above.
          good: '#1a7a4c', warn: '#b5570c', warning: '#b5570c', bad: '#ad2c22',
        },
        /**
         * The three divisions the company runs, plus the shared function.
         * Every figure in Finance and the Command Center is cut by these, so
         * they are a categorical palette and are held to that standard rather
         * than to taste: fixed order, never cycled, and the same hue for a
         * division wherever it appears — a dot in a table and a bar in a
         * chart are the same entity and must not disagree.
         *
         * These are validated steps, not the brand's display hues. The brand
         * grey for Shared reads as no-hue at all (chroma 0.014, well under the
         * 0.1 floor) and its green missed 3:1 against paper; both were re-stepped
         * in the same families until the palette passed. The one surviving
         * warning is green↔orange at ΔE 7.4 under protanopia, which is legal in
         * the 6–8 band only with secondary encoding — hence the legend and
         * direct labels on every chart that uses them.
         */
        div: {
          software: '#2a78d6',
          skill: '#c2670f',
          education: '#12805c',
          shared: '#8f3d90',
        },
      },
      fontFamily: {
        // Archivo carries every heading and every number. Its 112% width axis
        // is what makes a column of figures read as a block rather than a list.
        display: ['Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['Archivo', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        sm: '14px',
        DEFAULT: '16px',
        md: '18px',
        lg: '22px',
        xl: '30px',
      },
      boxShadow: {
        none: 'none',
        // Resting: barely off the page — the ghost of a hairline, not a shadow.
        soft: '0 1px 2px 0 rgba(15,15,18,0.05)',
        // Raised: an ordinary card or control, one clear step off the ground.
        raised: '0 1px 2px rgba(15,15,18,0.04), 0 6px 16px -4px rgba(15,15,18,0.10)',
        // Floating: a hovered/lifted element, or a card that owns attention.
        floating: '0 4px 10px rgba(15,15,18,0.06), 0 16px 36px -8px rgba(15,15,18,0.16)',
        // Glass: something over content — modal, dropdown, popover, palette.
        glass: '0 8px 20px rgba(15,15,18,0.10), 0 28px 60px -12px rgba(15,15,18,0.28)',
      },
      backdropBlur: {
        glass: '20px',
      },
    },
  },
  plugins: [],
};
