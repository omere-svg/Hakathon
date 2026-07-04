// Tests for the feature-flag store: defaults, patching, reset, and subscriptions.
// Runs in Node where localStorage may be absent — the store must degrade gracefully.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLAGS, getFlags, resetFlags, setFlags, subscribeFlags } from './features';

afterEach(() => {
  resetFlags();
});

describe('feature flags', () => {
  it('defaults: milestone engine, thinking off', () => {
    expect(DEFAULT_FLAGS.engine).toBe('milestone');
    expect(DEFAULT_FLAGS.thinking).toBe(false);
    expect(getFlags().engine).toBe('milestone');
  });

  it('setFlags patches without clobbering other flags', () => {
    setFlags({ thinking: true });
    expect(getFlags().thinking).toBe(true);
    expect(getFlags().engine).toBe('milestone');
  });

  it('resetFlags restores defaults', () => {
    setFlags({ thinking: true });
    resetFlags();
    expect(getFlags().thinking).toBe(false);
  });

  it('subscribers are notified on change and can unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeFlags(listener);
    setFlags({ thinking: true });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ thinking: true }));
    off();
    setFlags({ thinking: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
