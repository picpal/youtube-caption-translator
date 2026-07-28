import { describe, expect, it } from 'vitest';
import { RefCount } from './keepalive-refcount';

describe('RefCount', () => {
  it('acquire() returns true on the 0->1 transition (start the resource)', () => {
    const refCount = new RefCount();
    expect(refCount.acquire()).toBe(true);
    expect(refCount.value).toBe(1);
  });

  it('acquire() returns false for every subsequent holder while others are still active', () => {
    const refCount = new RefCount();
    expect(refCount.acquire()).toBe(true);
    expect(refCount.acquire()).toBe(false);
    expect(refCount.acquire()).toBe(false);
    expect(refCount.value).toBe(3);
  });

  it('release() returns false while other holders remain', () => {
    const refCount = new RefCount();
    refCount.acquire();
    refCount.acquire();
    expect(refCount.release()).toBe(false);
    expect(refCount.value).toBe(1);
  });

  it('release() returns true only on the 1->0 transition (stop the resource)', () => {
    const refCount = new RefCount();
    refCount.acquire();
    refCount.acquire();
    expect(refCount.release()).toBe(false); // 2 -> 1
    expect(refCount.release()).toBe(true); // 1 -> 0
    expect(refCount.value).toBe(0);
  });

  // The scenario this whole class exists for: one pipeline finishing early
  // must NOT stop the shared keepalive while another is still running.
  it('a later acquire is not stopped by an earlier release once a second holder has joined', () => {
    const refCount = new RefCount();
    expect(refCount.acquire()).toBe(true); // pipeline A starts -> interval starts
    expect(refCount.acquire()).toBe(false); // pipeline B starts -> shares it
    expect(refCount.release()).toBe(false); // pipeline A finishes -> interval must stay up
    expect(refCount.release()).toBe(true); // pipeline B finishes -> now stop it
  });

  it('release() never goes negative and an unbalanced extra release is a no-op', () => {
    const refCount = new RefCount();
    expect(refCount.release()).toBe(false);
    expect(refCount.value).toBe(0);
    expect(refCount.acquire()).toBe(true);
    expect(refCount.release()).toBe(true);
    expect(refCount.release()).toBe(false); // already at 0, not a spurious re-teardown
    expect(refCount.value).toBe(0);
  });

  it('supports a full cycle repeating (start -> stop -> start -> stop)', () => {
    const refCount = new RefCount();
    expect(refCount.acquire()).toBe(true);
    expect(refCount.release()).toBe(true);
    expect(refCount.acquire()).toBe(true);
    expect(refCount.release()).toBe(true);
  });
});
