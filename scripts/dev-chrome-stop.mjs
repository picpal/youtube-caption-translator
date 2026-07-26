#!/usr/bin/env node
// Stops the dev:chrome instance by matching its isolated --user-data-dir on
// the process command line. Never touches the user's real Chrome/profile.
//
// Usage: pnpm dev:chrome:stop
import { execSync } from 'node:child_process';
import { PROFILE_DIR } from './lib/config.mjs';

const pattern = `--user-data-dir=${PROFILE_DIR}`;

function findPids() {
  try {
    // `--` stops pgrep from parsing a pattern beginning with `-` as an option.
    return execSync(`pgrep -f -- ${JSON.stringify(pattern)}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

async function main() {
  const pids = findPids();
  if (pids.length === 0) {
    console.log('[dev:chrome:stop] No running dev:chrome instance found (nothing matched the profile dir).');
    return;
  }

  console.log(`[dev:chrome:stop] Stopping ${pids.length} process(es) using profile ${PROFILE_DIR}: ${pids.join(', ')}`);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      console.warn(`[dev:chrome:stop] Failed to signal pid ${pid}: ${err.message}`);
    }
  }

  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (findPids().length === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const remaining = findPids();
  if (remaining.length > 0) {
    console.warn(`[dev:chrome:stop] Still running after SIGTERM: ${remaining.join(', ')}. Sending SIGKILL.`);
    for (const pid of remaining) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  } else {
    console.log('[dev:chrome:stop] Stopped.');
  }
}

main();
