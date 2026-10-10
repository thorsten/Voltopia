/**
 * Runtime platform detection and the few things WKWebView inside the
 * Tauri app cannot do on its own. Tauri modules are loaded lazily so the
 * browser bundle never includes them and node tests never import them.
 */

/** True inside the Tauri (macOS / iPadOS) app, false in a browser. */
export function isNativeApp(
  win: unknown = typeof window === 'undefined' ? undefined : window,
): boolean {
  return typeof win === 'object' && win !== null && '__TAURI_INTERNALS__' in win;
}

export interface NativeFileApi {
  save(options: {
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  writeTextFile(path: string, contents: string): Promise<void>;
}

/** The Tauri dialog + fs plugins, loaded on first use. */
export async function loadNativeFileApi(): Promise<NativeFileApi> {
  const [{ save }, { writeTextFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  return { save, writeTextFile };
}

export interface ExportDeps {
  native?: boolean;
  nativeApi?: () => Promise<NativeFileApi>;
  doc?: Document;
}

/**
 * Hand `text` to the user as a file. Browsers download it; the native app
 * shows a save dialog (anchor downloads are a no-op in WKWebView). A
 * cancelled dialog writes nothing.
 */
export async function exportTextFile(
  fileName: string,
  text: string,
  { native = isNativeApp(), nativeApi = loadNativeFileApi, doc }: ExportDeps = {},
): Promise<void> {
  if (native) {
    const api = await nativeApi();
    const path = await api.save({
      defaultPath: fileName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (path) await api.writeTextFile(path, text);
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = (doc ?? document).createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
