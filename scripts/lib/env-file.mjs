// Minimal, dependency-free .env-style file parser. Zero deps by design —
// do not replace with the `dotenv` package.
//
// Supports: KEY=VALUE pairs, blank lines, full-line `#` comments, optional
// surrounding single or double quotes, trailing whitespace, and `=`
// characters inside the value (only the first `=` on a line splits key from
// value).
import fs from 'node:fs';

/** @returns {Record<string,string>} */
export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const result = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    const isQuoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (isQuoted) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}
