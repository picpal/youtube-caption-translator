import type { Config } from 'tailwindcss';
import path from 'node:path';

// A preview-only Tailwind config. Same content globs as the production
// ../tailwind.config.ts, but with `darkMode: 'class'` instead of `'media'`
// so the dev panel's light/dark toggle can flip the harness without relying
// on the OS/browser `prefers-color-scheme` setting.
//
// This is intentionally a separate file rather than a mutation of the real
// tailwind.config.ts: production stays on `darkMode: 'media'` (untouched),
// and only the preview Vite server's PostCSS pipeline (see vite.config.ts)
// uses this config.
const projectRoot = path.resolve(__dirname, '..');

export default {
  darkMode: 'class',
  content: [
    path.join(projectRoot, 'entrypoints/**/*.{html,tsx,ts}'),
    path.join(projectRoot, 'src/**/*.{tsx,ts}'),
    path.join(__dirname, '**/*.{html,ts,tsx}'),
  ],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
