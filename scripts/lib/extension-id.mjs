// Deterministically reproduces the extension ID Chrome assigns to an
// unpacked extension loaded from a given absolute path (when the manifest
// has no "key" field, which is our case).
//
// Algorithm (verified empirically against a real `Extensions.loadUnpacked`
// result on Chrome 150.0.7871.184 stable — see dev-chrome-tooling-report.md):
//   1. SHA-256 hash the exact absolute path string (the same string passed
//      to `Extensions.loadUnpacked({ path })`), UTF-8, hex digest.
//   2. Take the first 32 hex characters.
//   3. Map each hex nibble (0-15) to a letter 'a'-'p' (0->a, 1->b, ..., 15->p).
//
// This lets both dev-chrome.mjs and dev-chrome-check.mjs know the extension
// ID *before* any Chrome target for it exists — no live service worker or
// persisted state file required.
import crypto from 'node:crypto';

export function computeExtensionId(absolutePath) {
  const hash = crypto.createHash('sha256').update(absolutePath, 'utf8').digest('hex');
  const prefix = hash.slice(0, 32);
  return prefix.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}
