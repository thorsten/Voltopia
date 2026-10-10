import { describe, expect, it, vi } from 'vitest';
import { exportTextFile, isNativeApp } from './platform.ts';

function fakeDocument() {
  const anchor = { href: '', download: '', click: vi.fn() };
  const doc = { createElement: vi.fn(() => anchor) } as unknown as Document;
  return { doc, anchor };
}

describe('isNativeApp', () => {
  it('is false without a window', () => {
    expect(isNativeApp(undefined)).toBe(false);
  });
  it('is true when Tauri injected its internals', () => {
    expect(isNativeApp({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isNativeApp({})).toBe(false);
  });
});

describe('exportTextFile', () => {
  it('uses the anchor download outside the native app', async () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() });
    vi.stubGlobal('Blob', class {});
    const { doc, anchor } = fakeDocument();
    const nativeApi = vi.fn();
    await exportTextFile('a.json', '{}', { native: false, nativeApi, doc });
    expect(anchor.download).toBe('a.json');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(nativeApi).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('asks for a path and writes the file in the native app', async () => {
    const api = { save: vi.fn(async () => '/tmp/a.json'), writeTextFile: vi.fn(async () => {}) };
    const { doc, anchor } = fakeDocument();
    await exportTextFile('a.json', '{"x":1}', { native: true, nativeApi: async () => api, doc });
    expect(api.save).toHaveBeenCalledWith({
      defaultPath: 'a.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    expect(api.writeTextFile).toHaveBeenCalledWith('/tmp/a.json', '{"x":1}');
    expect(anchor.click).not.toHaveBeenCalled();
  });

  it('writes nothing when the dialog is cancelled', async () => {
    const api = { save: vi.fn(async () => null), writeTextFile: vi.fn(async () => {}) };
    await exportTextFile('a.json', '{}', { native: true, nativeApi: async () => api });
    expect(api.writeTextFile).not.toHaveBeenCalled();
  });
});
