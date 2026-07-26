import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import tailwindPreviewConfig from './tailwind.preview.config';

// Standalone Vite dev server for the local preview harness. It serves the
// real popup/options/sidepanel entrypoints (imported unmodified from
// ../entrypoints) with a mock `chrome` object injected in front of them —
// see ./mock-chrome.ts. This config is entirely separate from wxt's own
// build pipeline and does not affect `pnpm build` / `pnpm dev`.
export default defineConfig({
  root: __dirname,
  // Keep Vite's dependency-optimizer cache out of preview/ (it defaults to
  // <root>/node_modules/.vite, which would create preview/node_modules).
  cacheDir: path.resolve(__dirname, '../node_modules/.vite-preview'),
  plugins: [react()],
  resolve: {
    alias: {
      '~': path.resolve(__dirname, '..', 'src'),
    },
  },
  css: {
    postcss: {
      plugins: [tailwindcss(tailwindPreviewConfig), autoprefixer()],
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
