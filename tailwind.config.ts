import type { Config } from 'tailwindcss';

export default {
  darkMode: 'media',
  content: [
    './entrypoints/**/*.{html,tsx,ts}',
    './src/**/*.{tsx,ts}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
