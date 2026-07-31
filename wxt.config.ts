import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: './src',
  entrypointsDir: '../entrypoints',
  manifest: {
    name: 'YouTube Caption Translator',
    description: 'Translate YouTube tech-talk captions into your chosen language, with synchronized transcript, summary, and export',
    permissions: ['storage', 'sidePanel'],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://generativelanguage.googleapis.com/*',
    ],
    // Provisional placeholder icons (plain solid-background glyph) so the
    // pinned toolbar button isn't a generic puzzle piece. A later task
    // replaces these with real branding. See src/public/icons/.
    icons: {
      16: 'icons/16.png',
      32: 'icons/32.png',
      48: 'icons/48.png',
      128: 'icons/128.png',
    },
    action: {
      default_title: 'YouTube Caption Translator',
      default_icon: {
        16: 'icons/16.png',
        32: 'icons/32.png',
        48: 'icons/48.png',
        128: 'icons/128.png',
      },
    },
  },
});
