import { describe, expect, it } from 'vitest';
import { BlockAllocator } from './blocks.ts';

describe('BlockAllocator', () => {
  it('hands out distinct blocks and tracks the high-water mark', () => {
    const a = new BlockAllocator(4);
    const x = a.alloc();
    const y = a.alloc();
    expect(x).not.toBe(y);
    expect(a.live).toBe(2);
    expect(a.highWater).toBe(2);
  });

  it('reuses released blocks instead of growing', () => {
    const a = new BlockAllocator(4);
    const x = a.alloc();
    a.alloc();
    a.release(x);
    expect(a.live).toBe(1);
    expect(a.alloc()).toBe(x);
    expect(a.highWater).toBe(2);
  });

  it('lowers the high-water mark when the top blocks are released', () => {
    const a = new BlockAllocator(4);
    const x = a.alloc();
    const y = a.alloc();
    const z = a.alloc();
    a.release(z);
    expect(a.highWater).toBe(2);
    a.release(x);
    expect(a.highWater).toBe(2); // y still holds block 1
    a.release(y);
    expect(a.highWater).toBe(0);
    expect(a.live).toBe(0);
  });

  it('ignores double releases', () => {
    const a = new BlockAllocator(2);
    const x = a.alloc();
    a.release(x);
    a.release(x);
    expect(a.live).toBe(0);
    expect(a.alloc()).toBe(x);
    expect(a.alloc()).not.toBe(x);
  });

  it('never leaks over many place/remove cycles', () => {
    const a = new BlockAllocator(8);
    for (let i = 0; i < 1000; i++) {
      const b = a.alloc();
      a.release(b);
    }
    expect(a.live).toBe(0);
    expect(a.highWater).toBe(0);
  });

  it('throws when the capacity is exhausted', () => {
    const a = new BlockAllocator(1);
    a.alloc();
    expect(() => a.alloc()).toThrow(/capacity/);
  });

  it('keeps live and highWater exact after a failed allocation', () => {
    const a = new BlockAllocator(2);
    const x = a.alloc();
    const y = a.alloc();
    expect(() => a.alloc()).toThrow(/capacity/);
    expect(a.live).toBe(2);
    a.release(x);
    a.release(y);
    expect(a.live).toBe(0);
    expect(a.highWater).toBe(0);
    a.alloc();
    expect(a.live).toBe(1);
    expect(a.highWater).toBe(1);
  });
});
