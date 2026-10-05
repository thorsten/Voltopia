import { describe, expect, it } from 'vitest';
import {
  isSmallScreen,
  rememberSmallScreenNoticeDismissed,
  wasSmallScreenNoticeDismissed,
} from './smallScreen.ts';

describe('isSmallScreen', () => {
  it('flags a portrait phone', () => {
    expect(isSmallScreen(390, 844)).toBe(true);
  });

  it('flags a landscape phone (short side still below the threshold)', () => {
    expect(isSmallScreen(844, 390)).toBe(true);
  });

  it('does not flag an iPad mini', () => {
    expect(isSmallScreen(744, 1133)).toBe(false);
  });

  it('does not flag a desktop window', () => {
    expect(isSmallScreen(1280, 800)).toBe(false);
  });

  it('flags just below the threshold', () => {
    expect(isSmallScreen(599, 2000)).toBe(true);
  });

  it('does not flag exactly at the threshold', () => {
    expect(isSmallScreen(600, 2000)).toBe(false);
  });
});

// The unit tests run under vitest's 'node' environment (see
// vitest.config.ts), which has no sessionStorage global at all — so each
// test stubs it itself (a working in-memory one, or a throwing one) and
// restores whatever was there afterwards.
function withStubbedSessionStorage(stub: Storage, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: stub,
  });
  try {
    run();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'sessionStorage', original);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).sessionStorage;
    }
  }
}

describe('small screen notice dismissal', () => {
  it('round-trips through sessionStorage when available', () => {
    const store = new Map<string, string>();
    const stub = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    } as Storage;
    withStubbedSessionStorage(stub, () => {
      expect(wasSmallScreenNoticeDismissed()).toBe(false);
      rememberSmallScreenNoticeDismissed();
      expect(wasSmallScreenNoticeDismissed()).toBe(true);
    });
  });

  it('returns false when sessionStorage throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('sessionStorage unavailable');
      },
    });
    try {
      expect(wasSmallScreenNoticeDismissed()).toBe(false);
      expect(() => rememberSmallScreenNoticeDismissed()).not.toThrow();
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'sessionStorage', original);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (globalThis as any).sessionStorage;
      }
    }
  });
});
