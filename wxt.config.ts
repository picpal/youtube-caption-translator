import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: './src',
  entrypointsDir: '../entrypoints',
  manifest: {
    name: 'YouTube Play Assistant',
    description: 'YouTube tech talks with Korean subtitles and transcript',
    permissions: ['storage', 'sidePanel'],
    host_permissions: [
      'https://www.youtube.com/*',
      'https://generativelanguage.googleapis.com/*',
    ],
    action: {
      default_title: 'YouTube Play Assistant',
      default_popup: 'popup.html',
    },
  },
});
