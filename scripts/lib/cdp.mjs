// Minimal Chrome DevTools Protocol client over the platform's global
// WebSocket (Node 24+ ships one natively — no `ws` dependency needed).
export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Set();
    ws.addEventListener('message', (ev) => this._onMessage(ev));
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener(
        'error',
        (e) => reject(new Error(`CDP WebSocket error connecting to ${url}: ${e.message || e}`)),
        { once: true },
      );
    });
    return new CDP(ws);
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`${msg.method ?? 'CDP call'} failed: ${msg.error.message} (code ${msg.error.code})`));
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      for (const handler of this.eventHandlers) handler(msg);
    }
  }

  /** Send a CDP command. Pass `sessionId` to target a specific attached target (flat sessions). */
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** Subscribe to raw CDP events (method+params). Returns an unsubscribe function. */
  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/** Fetch chrome://json/version equivalent to discover the browser WS endpoint. */
export async function getDebugInfo(port, timeoutMs = 1000) {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Attach to a target (flat session) and enable Runtime on it. Returns the sessionId. */
export async function attachAndEnableRuntime(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  return sessionId;
}

/** Evaluate a JS expression on an attached session, awaiting promises and returning by value. */
export async function evalJson(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) {
    throw new Error(
      `Runtime.evaluate threw: ${exceptionDetails.exception?.description || exceptionDetails.text}`,
    );
  }
  return result.value;
}

/** Poll an extension page target until chrome.runtime.sendMessage is available. */
export async function waitForExtensionPageReady(cdp, sessionId, timeoutMs = 8000) {
  const start = Date.now();
  const expr =
    "typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined' && typeof chrome.runtime.sendMessage === 'function'";
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evalJson(cdp, sessionId, expr)) return true;
    } catch {
      // page may still be navigating; retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Find OUR extension's background service worker target, if loaded.
 *
 * A fresh Chrome profile also spins up its own built-in component
 * extensions (e.g. a Chrome Web Store helper), each with its own
 * `service_worker` target. Matching "any chrome-extension:// service
 * worker" is not enough to identify ours — we match on the service worker
 * script filename declared in our built manifest.json (normally
 * `background.js`) instead.
 */
export async function findExtensionServiceWorker(cdp, workerScriptName) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const suffix = `/${workerScriptName}`;
  return targetInfos.find(
    (t) =>
      t.type === 'service_worker' &&
      t.url.startsWith('chrome-extension://') &&
      t.url.endsWith(suffix),
  );
}
