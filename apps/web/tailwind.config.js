/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          950: '#0a0d14', 900: '#0f131c', 850: '#151a26', 800: '#1b2130',
          700: '#252d3f', 600: '#333d52', 500: '#4a5568', 400: '#6b7688',
          300: '#95a0b3', 200: '#c3cbd8', 100: '#e4e9f0', 50: '#f5f7fa',
        },
        accent: { DEFAULT: '#4f7cff', soft: '#7d9dff', deep: '#3560e0' },
        band: {
          strong: '#12a67c', stable: '#3d9970', watch: '#d99e2b',
          strained: '#e07a3c', critical: '#d5432f',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
    },
  },
  plugins: [],
};
