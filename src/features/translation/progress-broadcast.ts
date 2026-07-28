// Task 7 — background -> panel translation-progress Port broadcaster. A
// minimal, chrome-API-agnostic helper: fan a message out to every
// currently-registered "postable" client. `entrypoints/background.ts`'s real
// use is a `Set<chrome.runtime.Port>`, but this file itself never imports
// any chrome types — kept generic and pure so it is unit-testable without a
// chrome.* mock (Task 7's brief: the Port's own connect/disconnect lifecycle
// is a real-Chrome-only concern, but the fan-out/prune LOGIC is not).
export interface PostableClient<T> {
  postMessage: (message: T) => void;
}

/**
 * Sends `message` to every client currently in `clients`. A client whose
 * `postMessage` throws — a Port that has already closed but whose
 * `onDisconnect` listener hasn't fired yet in this same synchronous tick,
 * which Chrome's Port implementation allows — is pruned from the set on the
 * spot rather than left in place to throw again on the next broadcast. This
 * is the only place a stale entry gets removed outside of a normal
 * `onDisconnect` firing; it exists purely as a belt-and-suspenders guard so
 * one dead client can never take down delivery to the others.
 */
export function broadcastToPorts<T>(clients: Set<PostableClient<T>>, message: T): void {
  for (const client of clients) {
    try {
      client.postMessage(message);
    } catch {
      clients.delete(client);
    }
  }
}
