// Injects the mock chrome.* shim before the real popup entrypoint runs.
// Production code (../entrypoints/popup/main.tsx and everything it imports)
// is untouched — only import order here makes this work.
import './mock-chrome';
import '../entrypoints/popup/main';
