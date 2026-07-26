// Injects the mock chrome.* shim before the real options entrypoint runs.
// Production code (../entrypoints/options/main.tsx and everything it
// imports) is untouched — only import order here makes this work.
import './mock-chrome';
import '../entrypoints/options/main';
