import { describe, expect, it, vi } from 'vitest';
import { broadcastToPorts, type PostableClient } from './progress-broadcast';

function fakeClient<T>(impl: (message: T) => void = () => {}) {
  const postMessage = vi.fn<[T], void>(impl);
  return { postMessage } satisfies PostableClient<T>;
}

describe('broadcastToPorts', () => {
  it('posts the message to every client in the set', () => {
    const a = fakeClient<string>();
    const b = fakeClient<string>();
    const clients = new Set([a, b]);

    broadcastToPorts(clients, 'hello');

    expect(a.postMessage).toHaveBeenCalledWith('hello');
    expect(b.postMessage).toHaveBeenCalledWith('hello');
    expect(clients.size).toBe(2);
  });

  it('prunes a client whose postMessage throws, without affecting the others', () => {
    const throwing = fakeClient<string>(() => {
      throw new Error('port closed');
    });
    const healthy = fakeClient<string>();
    const clients = new Set([throwing, healthy]);

    broadcastToPorts(clients, 'ping');

    expect(healthy.postMessage).toHaveBeenCalledWith('ping');
    expect(clients.has(throwing)).toBe(false);
    expect(clients.has(healthy)).toBe(true);
  });

  it('does nothing for an empty set', () => {
    const clients = new Set<PostableClient<string>>();
    expect(() => broadcastToPorts(clients, 'noop')).not.toThrow();
  });

  it('a prune does not prevent later broadcasts from reaching clients added afterward', () => {
    const throwing = fakeClient<string>(() => {
      throw new Error('port closed');
    });
    const clients = new Set([throwing]);
    broadcastToPorts(clients, 'first');
    expect(clients.size).toBe(0);

    const healthy = fakeClient<string>();
    clients.add(healthy);
    broadcastToPorts(clients, 'second');
    expect(healthy.postMessage).toHaveBeenCalledWith('second');
  });
});
