# Native App (macOS / iPadOS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Voltopia as a Tauri v2 macOS app (`.app`/`.dmg`) and an iPadOS app built from the existing web `dist/`, with no behaviour change for the browser game.

**Architecture:** A new `src-tauri/` Rust shell wraps the unchanged frontend; `vite.config.ts` learns the Tauri dev-server contract and drops the PWA plugin under Tauri. The only frontend additions are `src/ui/platform.ts` (native detection + file export) and a save-on-quit hook driven by a `close-requested` event from Rust. CI gets a macOS build job that uploads unsigned bundles.

**Tech Stack:** Tauri 2.x (`@tauri-apps/cli` 2.12, `@tauri-apps/api` 2.12, plugins opener/dialog/fs 2.x; Rust stable), Vite 8, React 19, vitest (node env), pnpm 12, Xcode 16+ for iPad.

**Spec:** `docs/superpowers/specs/2026-10-10-native-app-design.md`

## Global Constraints

- Browser build unchanged: `pnpm build` with `VOLTOPIA_BASE` set must produce the same GitHub Pages output as before (PWA included). The PWA plugin is skipped **only** when `process.env.TAURI_ENV_PLATFORM` is set.
- Bundle identifier `info.rinne.voltopia`; product name `Voltopia`; `version` mirrors `package.json` (`0.1.0`).
- macOS window: 1280×800, min 960×600, resizable. `bundle.macOS.minimumSystemVersion` `12.0`; `bundle.iOS.minimumSystemVersion` `15.0`; iPad only (`TARGETED_DEVICE_FAMILY: "2"`).
- CSP exactly as in the spec (`worker-src 'self' blob:` is required for the sim worker).
- Capabilities limited to `core:default`, `core:event:allow-listen`, `opener:default`, `dialog:allow-save`, `fs:allow-write-text-file` + fs scope `$DOWNLOAD/**`, `$DOCUMENT/**`.
- New frontend code lives in `src/ui/`; it must not import three.js or anything from `src/sim/`. Tauri modules are imported dynamically or injected so the browser bundle and node tests never load them.
- React effects depend on `send`/`onSaveData` (stable identities), never on the `bridge` object (CLAUDE.md).
- No new dependency with install scripts (`@tauri-apps/*` have none — verify with `pnpm install` not failing with `ERR_PNPM_IGNORED_BUILDS`). `pnpm audit:prod` must stay green.
- Rust builds only on the Mac (the Linux sandbox has no cargo/Xcode). Every task that needs `pnpm tauri …` says so; everything else must pass in the sandbox: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- `pnpm format` after edits. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never `--no-verify`.
- Branch `feature/native-app`.

## Review Focus

1. **Quit while the worker is stalled** — Cmd+Q must still quit within ~2 s and must not lose the last autosave that did succeed. Pinned in Task 5 (`closes after the timeout when no save arrives`).
2. **Close requested twice** (user hits Cmd+Q, then clicks the red button during the save) — exactly one `close_app` call, no double save. Pinned in Task 5 (`ignores a second close request while one is pending`).
3. **Export dialog cancelled** — nothing is written, no error toast. Pinned in Task 4 (`writes nothing when the dialog is cancelled`).
4. **Browser export unchanged** — in a browser `exportTextFile` still uses the anchor download and never touches Tauri modules. Pinned in Task 4 (`uses the anchor download outside the native app`).
5. **Web build regression** — PWA still emitted when `TAURI_ENV_PLATFORM` is unset. Pinned in Task 2 (grep for `sw.js` in `dist/` after a plain `pnpm build`).

---

### Task 0: Branch

- [ ] `git checkout -b feature/native-app`

---

### Task 1: Dependencies and scripts

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml` (generated)

**Interfaces — produces:** `pnpm tauri <args>` runs the Tauri CLI; `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs` importable from `src/ui`.

- [ ] **Step 1: Add the packages.**

```bash
pnpm add -D @tauri-apps/cli@^2.12.1
pnpm add @tauri-apps/api@^2.12.2 @tauri-apps/plugin-opener@^2 @tauri-apps/plugin-dialog@^2 @tauri-apps/plugin-fs@^2
```

Expected: install succeeds without `ERR_PNPM_IGNORED_BUILDS`. If it does fail with that error, run `pnpm approve-builds <pkg>` and commit `pnpm-workspace.yaml` in this same commit (CLAUDE.md).

- [ ] **Step 2: Add the script.** In `package.json` `"scripts"`, after `"prepare"`:

```json
    "tauri": "tauri"
```

- [ ] **Step 3: Verify.**

```bash
pnpm tauri --version      # prints tauri-cli 2.12.x (works in the sandbox, no Rust needed)
pnpm audit:prod           # no high/critical
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

- [ ] **Step 4: Commit.**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "build: add Tauri v2 CLI, API and plugins

Groundwork for the macOS and iPadOS app wrappers. No runtime use yet.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Vite config for the Tauri dev server and build

**Files:**

- Modify: `vite.config.ts`

**Interfaces — produces:** `pnpm dev` listens on `TAURI_DEV_HOST` when set (iPad device dev), fixed port 5173; PWA plugin absent when `TAURI_ENV_PLATFORM` is set.

- [ ] **Step 1: Rewrite `vite.config.ts`.** Keep the existing `VitePWA({...})` options verbatim (move them into a `pwa()` helper); the shape becomes:

```ts
import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Set by the Tauri CLI when it runs the dev server for a physical iPad.
const tauriDevHost = process.env.TAURI_DEV_HOST;
// Set by the Tauri CLI for both `beforeDevCommand` and `beforeBuildCommand`.
// The native app is bundled and offline anyway; a Service Worker inside
// the tauri:// origin only causes stale-asset bugs.
const isTauriBuild = Boolean(process.env.TAURI_ENV_PLATFORM);

function pwa(): PluginOption {
  return VitePWA({/* …existing options, unchanged… */});
}

export default defineConfig({
  // For GitHub Pages the app is served from /<repo>/ — the deploy
  // workflow sets VOLTOPIA_BASE accordingly. Tauri builds leave it unset.
  base: process.env.VOLTOPIA_BASE ?? '/',
  // Keep Rust compiler errors visible when Tauri drives Vite.
  clearScreen: false,
  // Expose TAURI_ENV_* to the app (platform, arch, debug) for future use.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  plugins: [react(), ...(isTauriBuild ? [] : [pwa()])],
  server: {
    port: 5173,
    strictPort: true,
    host: tauriDevHost || false,
    hmr: tauriDevHost ? { protocol: 'ws', host: tauriDevHost, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  worker: {
    format: 'es',
  },
});
```

- [ ] **Step 2: Verify the web build still ships the PWA (Review Focus 5).**

```bash
pnpm build && ls dist/sw.js dist/manifest.webmanifest
TAURI_ENV_PLATFORM=darwin pnpm build && ls dist/sw.js 2>&1 | grep -q 'No such file' && echo "PWA skipped under Tauri: OK"
pnpm build   # leave dist/ in the web state
```

- [ ] **Step 3: Verify e2e still boots** (Playwright passes its own `--port 5199 --strictPort`, so the config port does not clash): `pnpm e2e` (in the sandbox the WebGL test skips; that is expected).

- [ ] **Step 4: `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check` then commit.**

```bash
git add vite.config.ts
git commit -m "build(vite): support the Tauri dev host and skip the PWA under Tauri

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Tauri shell (`src-tauri/`) — macOS runs

**Needs the Mac** (Rust stable via rustup, Xcode command line tools).

**Files:**

- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/icons/*` (generated), `src-tauri/.gitignore`
- Modify: `.gitignore`

**Interfaces — produces:** `pnpm tauri dev` opens the game in a window; `pnpm tauri build` writes `src-tauri/target/release/bundle/macos/Voltopia.app` and `…/dmg/Voltopia_0.1.0_aarch64.dmg`. Rust command `close_app` and event `close-requested` exist (wired to the frontend in Task 5).

- [ ] **Step 1: `src-tauri/Cargo.toml`**

```toml
[package]
name = "voltopia"
version = "0.1.0"
description = "Voltopia — a city builder powered entirely by renewables"
authors = ["Thorsten Rinne"]
edition = "2021"

[lib]
name = "voltopia_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: `src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: `src-tauri/src/main.rs`**

```rust
// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    voltopia_lib::run()
}
```

- [ ] **Step 4: `src-tauri/src/lib.rs`**

```rust
use tauri::Emitter;

/// Called by the frontend once the autosave has been written (or timed
/// out) after a `close-requested` event. Desktop only: iPadOS suspends
/// the app instead of quitting it.
#[tauri::command]
fn close_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![close_app])
        .on_window_event(|window, event| {
            // Hold the window open until the frontend has autosaved; it
            // answers with `close_app`. A frontend timeout guarantees the
            // app never becomes unquittable.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Voltopia");
}
```

- [ ] **Step 5: `src-tauri/tauri.conf.json`**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Voltopia",
  "version": "0.1.0",
  "identifier": "info.rinne.voltopia",
  "build": {
    "beforeDevCommand": "pnpm dev",
    "devUrl": "http://localhost:5173",
    "beforeBuildCommand": "pnpm build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Voltopia",
        "width": 1280,
        "height": 800,
        "minWidth": 960,
        "minHeight": 600,
        "resizable": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; worker-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "category": "Game",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "macOS": { "minimumSystemVersion": "12.0" },
    "iOS": { "minimumSystemVersion": "15.0" }
  }
}
```

- [ ] **Step 6: `src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Voltopia main window: events, external links, save export",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:allow-listen",
    "opener:default",
    "dialog:allow-save",
    "fs:allow-write-text-file",
    {
      "identifier": "fs:scope",
      "allow": [{ "path": "$DOWNLOAD/**" }, { "path": "$DOCUMENT/**" }]
    }
  ]
}
```

- [ ] **Step 7: Icons and ignores.**

```bash
pnpm tauri icon public/icon.svg        # writes src-tauri/icons/*
printf 'target/\ngen/schemas/\n' > src-tauri/.gitignore
```

Append to the root `.gitignore`:

```
# Tauri (Rust target dir and generated schemas; gen/apple IS committed)
src-tauri/target/
src-tauri/gen/schemas/
```

- [ ] **Step 8: Run it.**

```bash
pnpm tauri dev
```

Expected: a "Voltopia" window, 3D view rendering, tick counter advancing, roads drag, Cmd+S saves (toast), the imprint "Web" link opens the system browser (opener plugin). Open the WebKit inspector (right-click → Inspect Element in dev builds) and confirm **no CSP violations** in the console — if the sim worker is blocked, the CSP is wrong, fix it here, do not widen to `'unsafe-eval'`.

- [ ] **Step 9: Build it.**

```bash
pnpm tauri build
open src-tauri/target/release/bundle/macos/Voltopia.app
```

Expected: unsigned (ad-hoc) app launches; autosave survives relaunch (IndexedDB persists in the app's WebKit data store).

- [ ] **Step 10: Sandbox gate and commit** (run on the Mac or the sandbox; the Rust files are not touched by the gate).

```bash
pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
git add src-tauri .gitignore
git commit -m "feat(native): add the Tauri shell for a macOS app

Rust shell with opener/dialog/fs plugins, a strict CSP, a close-requested
handshake (frontend wiring follows) and generated icons. pnpm tauri dev /
build produce a working macOS app from the unchanged web build.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Platform module and native save export

**Files:**

- Create: `src/ui/platform.ts`, `src/ui/platform.test.ts`
- Modify: `src/ui/SettingsPage.tsx:61-69`

**Interfaces — produces:**

```ts
export function isNativeApp(win?: unknown): boolean;
export interface NativeFileApi {
  save(options: {
    defaultPath?: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  writeTextFile(path: string, contents: string): Promise<void>;
}
export function loadNativeFileApi(): Promise<NativeFileApi>; // dynamic imports of the Tauri plugins
export function exportTextFile(
  fileName: string,
  text: string,
  deps?: { native?: boolean; nativeApi?: () => Promise<NativeFileApi>; doc?: Document },
): Promise<void>;
```

- [ ] **Step 1: Failing tests — `src/ui/platform.test.ts`**

```ts
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
```

- [ ] **Step 2: Run, expect failure.** `pnpm vitest run src/ui/platform.test.ts` → "Failed to resolve import './platform.ts'".

- [ ] **Step 3: Implement `src/ui/platform.ts`**

```ts
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
```

- [ ] **Step 4: Use it in `SettingsPage.tsx`.** Replace the body of `exportSave`:

```ts
const exportSave = async (): Promise<void> => {
  const snapshot = await requestSnapshot();
  await exportTextFile(
    `voltopia-save-${new Date().toISOString().slice(0, 10)}.json`,
    saveToJson(snapshot),
  );
};
```

and add `import { exportTextFile } from './platform.ts';`.

- [ ] **Step 5: Run tests, expect pass.** `pnpm vitest run src/ui/platform.test.ts`; then the full gate `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.

- [ ] **Step 6 (Mac): manual check.** `pnpm tauri dev` → Settings → Export: a save dialog appears; the written file re-imports via Import. Browser (`pnpm dev`): export still downloads.

- [ ] **Step 7: Commit.**

```bash
git add src/ui/platform.ts src/ui/platform.test.ts src/ui/SettingsPage.tsx
git commit -m "feat(ui): export save games through a native dialog in the app

Anchor downloads are a no-op in WKWebView; the Tauri app uses the dialog
and fs plugins instead. Browser behaviour unchanged.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Save on quit (desktop)

**Files:**

- Create: `src/ui/nativeClose.ts`, `src/ui/nativeClose.test.ts`
- Modify: `src/ui/App.tsx:171-195` (the autosave effect)

**Interfaces — consumes:** `SimBridge.send(command)`, `SimBridge.onSaveData(listener) => unsubscribe`, `storage.save(save): Promise<void>`, event `close-requested` and command `close_app` from Task 3, `isNativeApp()` from Task 4.

**Interfaces — produces:**

```ts
export interface CloseDeps {
  send: (command: { type: 'requestSave' }) => void;
  onSaveData: (listener: (save: SaveGame) => void) => () => void;
  persist: (save: SaveGame) => Promise<void>;
  closeApp: () => Promise<void>;
  timeoutMs?: number; // default CLOSE_SAVE_TIMEOUT_MS = 2000
  setTimer?: typeof setTimeout; // injectable for tests
}
export const CLOSE_SAVE_TIMEOUT_MS = 2000;
/** Returns the handler to run on `close-requested`; idempotent while a close is pending. */
export function createCloseHandler(deps: CloseDeps): () => void;
/** Subscribes to Tauri's close-requested event; returns unsubscribe. No-op outside the app. */
export function listenForNativeClose(deps: CloseDeps, native?: boolean): () => void;
```

- [ ] **Step 1: Failing tests — `src/ui/nativeClose.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import type { SaveGame } from '../shared/types.ts';
import { CLOSE_SAVE_TIMEOUT_MS, createCloseHandler } from './nativeClose.ts';

function harness(persist = vi.fn(async () => {})) {
  let listener: ((save: SaveGame) => void) | null = null;
  const send = vi.fn();
  const closeApp = vi.fn(async () => {});
  const timers: Array<() => void> = [];
  const setTimer = ((fn: () => void) => {
    timers.push(fn);
    return 0;
  }) as unknown as typeof setTimeout;
  const onSaveData = (l: (save: SaveGame) => void) => {
    listener = l;
    return () => {
      listener = null;
    };
  };
  const handle = createCloseHandler({ send, onSaveData, persist, closeApp, setTimer });
  const save = {} as SaveGame;
  return { handle, send, closeApp, persist, timers, emitSave: () => listener?.(save) };
}

describe('createCloseHandler', () => {
  it('requests a save, persists it, then closes', async () => {
    const h = harness();
    h.handle();
    expect(h.send).toHaveBeenCalledWith({ type: 'requestSave' });
    expect(h.closeApp).not.toHaveBeenCalled();
    h.emitSave();
    await vi.waitFor(() => expect(h.closeApp).toHaveBeenCalledOnce());
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it('closes after the timeout when no save arrives', async () => {
    const h = harness();
    h.handle();
    expect(h.timers).toHaveLength(1);
    h.timers[0]();
    await vi.waitFor(() => expect(h.closeApp).toHaveBeenCalledOnce());
  });

  it('closes even when persisting fails', async () => {
    const h = harness(
      vi.fn(async () => {
        throw new Error('disk');
      }),
    );
    h.handle();
    h.emitSave();
    await vi.waitFor(() => expect(h.closeApp).toHaveBeenCalledOnce());
  });

  it('ignores a second close request while one is pending', async () => {
    const h = harness();
    h.handle();
    h.handle();
    expect(h.send).toHaveBeenCalledTimes(1);
    h.emitSave();
    h.timers.forEach((t) => t());
    await vi.waitFor(() => expect(h.closeApp).toHaveBeenCalledOnce());
  });

  it('exposes the timeout constant', () => {
    expect(CLOSE_SAVE_TIMEOUT_MS).toBe(2000);
  });
});
```

- [ ] **Step 2: Run, expect failure.** `pnpm vitest run src/ui/nativeClose.test.ts` → import error.

- [ ] **Step 3: Implement `src/ui/nativeClose.ts`**

```ts
import type { SaveGame } from '../shared/types.ts';
import { isNativeApp } from './platform.ts';

/** How long Cmd+Q waits for the worker's save snapshot before quitting anyway. */
export const CLOSE_SAVE_TIMEOUT_MS = 2000;

export interface CloseDeps {
  send: (command: { type: 'requestSave' }) => void;
  onSaveData: (listener: (save: SaveGame) => void) => () => void;
  persist: (save: SaveGame) => Promise<void>;
  closeApp: () => Promise<void>;
  timeoutMs?: number;
  setTimer?: typeof setTimeout;
}

/**
 * The desktop quit handshake: Rust holds the window open and emits
 * `close-requested`; we ask the worker for a snapshot, persist it, and
 * call `close_app`. A timeout makes sure a stalled worker cannot make the
 * app unquittable. Idempotent while a close is pending.
 */
export function createCloseHandler({
  send,
  onSaveData,
  persist,
  closeApp,
  timeoutMs = CLOSE_SAVE_TIMEOUT_MS,
  setTimer = setTimeout,
}: CloseDeps): () => void {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    let done = false;
    let unsubscribe: () => void = () => {};
    const finish = (): void => {
      if (done) return;
      done = true;
      unsubscribe();
      void closeApp();
    };
    unsubscribe = onSaveData((save) => {
      persist(save)
        .catch((error) => console.warn('Save on quit failed', error))
        .finally(finish);
    });
    setTimer(finish, timeoutMs);
    send({ type: 'requestSave' });
  };
}

/** Wire the handshake to Tauri. Outside the app this is a no-op. */
export function listenForNativeClose(deps: CloseDeps, native = isNativeApp()): () => void {
  if (!native) return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  const handler = createCloseHandler(deps);
  void import('@tauri-apps/api/event').then(({ listen }) =>
    listen('close-requested', handler).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    }),
  );
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** `closeApp` for `listenForNativeClose`: the Rust `close_app` command. */
export async function invokeCloseApp(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('close_app');
}
```

- [ ] **Step 4: Hook it into `App.tsx`.** Inside the existing autosave effect (the one that depends on `[send, onSaveData]`), after `document.addEventListener('visibilitychange', …)`:

```ts
// Desktop app: Cmd+Q waits for one last autosave (see nativeClose.ts).
const stopNativeClose = listenForNativeClose({
  send,
  onSaveData,
  persist: (save) => storage.save(save),
  closeApp: invokeCloseApp,
});
```

and in the cleanup: `stopNativeClose();`. Import: `import { invokeCloseApp, listenForNativeClose } from './nativeClose.ts';`

- [ ] **Step 5: Run tests and the gate.** `pnpm vitest run src/ui/nativeClose.test.ts` → 5 pass; `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.

- [ ] **Step 6 (Mac): manual check.** `pnpm tauri dev`: build a road, then Cmd+Q within the 10 s autosave interval; relaunch: the road is there. Timeout path: temporarily pass `timeoutMs: 1` in `App.tsx`, confirm the app still quits, revert before committing.

- [ ] **Step 7: Commit.**

```bash
git add src/ui/nativeClose.ts src/ui/nativeClose.test.ts src/ui/App.tsx
git commit -m "feat(native): autosave before the app quits

Rust holds the window open on close-requested; the frontend requests a
snapshot, persists it and calls close_app, with a 2 s timeout so a stalled
worker can never block quitting.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: iPad target and presentation

**Needs the Mac** with Xcode 16+, an iPad simulator runtime, and `rustup target add aarch64-apple-ios aarch64-apple-ios-sim` (also `x86_64-apple-ios` on Intel). CocoaPods is not needed.

**Files:**

- Modify: `index.html:5`
- Modify: `src/ui/app.css:68-73` (html/body/root block) and the HUD root rule
- Create: `src-tauri/gen/apple/**` (generated by `tauri ios init`, then one edit)

- [ ] **Step 1: Viewport.** In `index.html` replace the viewport meta:

```html
<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no"
/>
```

- [ ] **Step 2: CSS.** Extend the `html, body, #root` block in `src/ui/app.css`:

```css
html,
body,
#root {
  height: 100%;
  overflow: hidden;
  /* iPad: no rubber-banding, no long-press link sheet over the map. */
  overscroll-behavior: none;
  -webkit-touch-callout: none;
}
```

and on the HUD root container (the element that positions the islands; find it with `grep -n "position: fixed\|inset: 0" src/ui/app.css | head`) add:

```css
padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
  env(safe-area-inset-left);
```

Verify in the browser (`pnpm dev`, Chrome device toolbar "iPad Pro") that nothing shifts — `env()` is 0 outside notched devices.

- [ ] **Step 3: Generate the Xcode project.**

```bash
pnpm tauri ios init
```

Then in `src-tauri/gen/apple/project.yml`, under `targets: voltopia_iOS: settings: base:`, set:

```yaml
TARGETED_DEVICE_FAMILY: '2'
```

(iPad only; `"1,2"` would add iPhone). Leave `IPHONEOS_DEPLOYMENT_TARGET` at what `bundle.iOS.minimumSystemVersion` produced (`15.0`). Do **not** edit the `.xcodeproj` directly — Tauri regenerates it from `project.yml`.

- [ ] **Step 4: Run on the simulator.**

```bash
pnpm tauri ios dev 'iPad Pro 13-inch (M4)'
```

Checklist (record results in the commit body):

- 3D view renders; sim ticks.
- One-finger drag paints roads; two-finger pinch zooms the map, not the page; no rubber-band scroll.
- HUD islands sit inside the safe area in both orientations.
- Home → relaunch: city intact (`visibilitychange` autosave).
- Settings → Export opens the iOS document picker (dialog plugin) and writes a file to Files; Import reads it back.
- Imprint link opens Safari.

- [ ] **Step 5: Physical iPad (optional but recommended).** Xcode → Window → Devices and Simulators → pair the iPad; then `pnpm tauri ios dev --force-ip-prompt` and pick the `::2` address, or `pnpm tauri ios build --export-method debugging` with your personal team set via `APPLE_DEVELOPMENT_TEAM=<TEAMID>` in the environment (free Apple ID works for 7-day installs).

- [ ] **Step 6: Gate and commit.** `pnpm format && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`

```bash
git add index.html src/ui/app.css src-tauri/gen/apple
git commit -m "feat(native): iPad target with safe-area aware HUD

Xcode project from tauri ios init (iPad device family only), viewport
pinned so pinches zoom the map, overscroll and touch callouts disabled.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: CI — macOS build artefact

**Files:**

- Create: `.github/workflows/native.yml`

- [ ] **Step 1: Write the workflow.**

```yaml
name: Native app (macOS)

on:
  workflow_dispatch:
  push:
    tags: ['v*']

permissions:
  contents: read

jobs:
  macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v7

      - uses: pnpm/action-setup@v6
        with:
          version: 12

      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm

      - uses: dtolnay/rust-toolchain@stable

      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # Unsigned (ad-hoc) bundle: fine for local installs and testers who
      # right-click → Open. Signing/notarization is a follow-up.
      - name: Build macOS app
        run: pnpm tauri build --bundles app,dmg

      - uses: actions/upload-artifact@v7
        with:
          name: voltopia-macos
          path: |
            src-tauri/target/release/bundle/dmg/*.dmg
            src-tauri/target/release/bundle/macos/*.app
          retention-days: 14
```

- [ ] **Step 2: Trigger once manually** (`gh workflow run native.yml` after push, or from the Actions tab) and confirm the artefact downloads and launches.

- [ ] **Step 3: Commit.**

```bash
git add .github/workflows/native.yml
git commit -m "ci: build the macOS app on tags and on demand

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Documentation

**Files:**

- Modify: `README.md` (new section after "Development"/install notes), `CLAUDE.md` (Commands, Architecture, Environment gotchas), `docs/plan.md` (tick/record the native app)

- [ ] **Step 1: README — "Native app (macOS / iPadOS)" section.**

````markdown
## Native app (macOS / iPadOS)

The same build runs as a Tauri app. Requirements: Rust (rustup, stable)
and Xcode command line tools; for iPad also Xcode and
`rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.

```bash
pnpm tauri dev                     # macOS window with hot reload
pnpm tauri build                   # .app + .dmg in src-tauri/target/release/bundle/
pnpm tauri ios dev 'iPad Pro 13-inch (M4)'   # iPad simulator
pnpm tauri ios build --export-method debugging  # install on your own iPad
```

Builds are unsigned; macOS users open the `.dmg` and right-click → Open
once. Save games live in the app's own storage; use Settings → Export /
Import to move a city between browser and app.
````

- [ ] **Step 2: CLAUDE.md.** Commands: add `pnpm tauri dev|build|ios dev` with "(Mac only)". Architecture: add

```
- `src-tauri/` — Tauri v2 shell (Rust). Loads the unchanged `dist/`.
  Native-only frontend behaviour goes through `src/ui/platform.ts`
  (`isNativeApp()`, `exportTextFile`) and `src/ui/nativeClose.ts`; Tauri
  JS modules are imported dynamically so the web bundle and node tests
  never load them. CSP and capabilities live in `src-tauri/tauri.conf.json`
  and `src-tauri/capabilities/default.json` — widen them deliberately.
```

Environment gotchas: add

```
- The Linux sandbox cannot build the native app (no cargo, no Xcode);
  `pnpm tauri …` runs on the Mac. `src-tauri/gen/apple` is generated by
  `tauri ios init` and committed — edit `project.yml`, never the
  `.xcodeproj`. The PWA plugin is skipped when `TAURI_ENV_PLATFORM` is set.
```

- [ ] **Step 3: Gate and commit.**

```bash
pnpm format && pnpm format:check
git add README.md CLAUDE.md docs/plan.md
git commit -m "docs: describe the macOS / iPadOS app build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Follow-ups (not in this plan)

- Developer ID signing + notarization (`APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` secrets; Tauri signs and notarizes automatically when set).
- App Store: `bundle.macOS.entitlements` with `com.apple.security.app-sandbox`, `bundle.iOS.developmentTeam`, `pnpm tauri ios build --export-method app-store-connect`, `xcrun altool --upload-app`.
- Windows/Linux bundles via a CI matrix.
