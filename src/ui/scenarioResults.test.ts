import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBestResult, recordResult } from './scenarioResults.ts';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe('scenario results', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the best result: a win beats a loss, an earlier win beats a later one', () => {
    expect(readBestResult('island')).toBeNull();
    recordResult('island', 'failed', 40);
    expect(readBestResult('island')).toEqual({ status: 'failed', day: 40 });
    recordResult('island', 'won', 90);
    recordResult('island', 'failed', 10);
    expect(readBestResult('island')).toEqual({ status: 'won', day: 90 });
    recordResult('island', 'won', 80);
    expect(readBestResult('island')).toEqual({ status: 'won', day: 80 });
  });

  it('among losses keeps the one that lasted longer', () => {
    recordResult('island', 'failed', 20);
    recordResult('island', 'failed', 10);
    expect(readBestResult('island')).toEqual({ status: 'failed', day: 20 });
    recordResult('island', 'failed', 30);
    expect(readBestResult('island')).toEqual({ status: 'failed', day: 30 });
  });

  it('ignores unreadable stored data', () => {
    localStorage.setItem('voltopia.scenario.island', '{not json');
    expect(readBestResult('island')).toBeNull();
  });
});
