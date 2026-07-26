// Injects the mock chrome.* shim before the real sidepanel entrypoint runs.
// Production code (../entrypoints/sidepanel/main.tsx and everything it
// imports) is untouched — only import order here makes this work.
import './mock-chrome';
import '../entrypoints/sidepanel/main';
