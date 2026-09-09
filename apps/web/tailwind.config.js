/**
 * The Kaizen Infinities design system.
 *
 * Ink, paper and one accent. Flat — no depth effects anywhere, which is why
 * there is no boxShadow scale below. Hierarchy is carried by borders instead,
 * at three weights: a 1px hairline separates rows, 2px separates a component
 * from the page, 3px encloses something you are meant to read as one object.
 *
 * The `ink` scale runs the same direction it did when this app was dark —
 * 950 is the page, 100 is the strongest text — so every existing utility
 * keeps its meaning. Only the values were re-pointed onto paper.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#F2F2F4', // the page itself
          900: '#ffffff', // a surface raised off the page
          850: '#F2F2F4', // a hovered or recessed surface
          800: '#dcdce1', // hairline
          700: '#C9C9D2', // border
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
        },
        // The three divisions the company actually runs. Every figure in
        // Finance and the Command Center can be cut by these.
        div: {
          software: '#2a78d6',
          skill: '#d97a1e',
          education: '#1baf7a',
          shared: '#6b6b74',
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
        DEFAULT: '14px',
        md: '14px',
        lg: '20px',
        xl: '28px',
      },
      boxShadow: {
        // Flat by decision, not by omission. Anything that reaches for a
        // shadow should reach for a border instead.
        none: 'none',
      },
    },
  },
  plugins: [],
};
