/**
 * Pure glue for "share a city" links: building and parsing
 * `…/#city=<code>` URLs, reading the hash once per page load, copying
 * to the clipboard and keeping the current city before a shared one
 * replaces it. The share code itself lives in `src/storage/shareCode.ts`.
 */
import type { SaveGame } from '../shared/types.ts';
import { newSlotId, type SaveStorage } from '../storage/storage.ts';
import { isNativeApp, PUBLIC_WEB_URL } from './platform.ts';

export const SHARE_HASH_PREFIX = '#city=';

/** Links above this length get the "some apps shorten long links" warning. */
export const SHARE_LINK_WARN_LENGTH = 64 * 1024;

/** A bare share code: base64url, long enough not to be a stray word. */
const BARE_CODE = /^[A-Za-z0-9_-]{16,}$/;

/**
 * The page a share link opens. The native app has no URL of its own, so
 * its links point at the public web build.
 */
export function shareBaseUrl(
  deps: { native?: boolean; origin?: string; base?: string } = {},
): string {
  if (deps.native ?? isNativeApp()) return PUBLIC_WEB_URL;
  return new URL(deps.base ?? import.meta.env.BASE_URL, deps.origin ?? location.origin).href;
}

export function shareUrl(code: string, base: string = shareBaseUrl()): string {
  return base + SHARE_HASH_PREFIX + code;
}

/** Accepts a full link, a bare '#city=…' or just the code; trims whitespace; null when nothing usable. */
export function extractShareCode(input: string): string | null {
  const trimmed = input.trim();
  const at = trimmed.indexOf(SHARE_HASH_PREFIX);
  if (at >= 0) {
    const code = trimmed.slice(at + SHARE_HASH_PREFIX.length).trim();
    return code === '' ? null : code;
  }
  return BARE_CODE.test(trimmed) ? trimmed : null;
}

/** `undefined` until the hash of this page load has been read. */
let takenThisLoad: string | null | undefined;

/**
 * The '#city=' code of this page load, read ONCE (StrictMode-safe cache like
 * consumePendingNewGame); strips the hash via history.replaceState on first read.
 */
export function takeShareCodeOnce(
  loc: Pick<Location, 'hash' | 'pathname' | 'search'> | undefined = typeof location === 'undefined'
    ? undefined
    : location,
  hist: Pick<History, 'replaceState' | 'state'> | undefined = typeof history === 'undefined'
    ? undefined
    : history,
): string | null {
  if (takenThisLoad !== undefined) return takenThisLoad;
  takenThisLoad = null;
  if (!loc || !loc.hash.startsWith(SHARE_HASH_PREFIX)) return takenThisLoad;
  // Read before stripping: a real `location` is live and loses the hash.
  const code = loc.hash.slice(SHARE_HASH_PREFIX.length);
  // Strip now, so a reload (including replaceCityAndReload's) never asks twice.
  hist?.replaceState(hist.state, '', loc.pathname + loc.search);
  takenThisLoad = code === '' ? null : code;
  return takenThisLoad;
}

export function resetShareCodeCacheForTests(): void {
  takenThisLoad = undefined;
}

/** False where CompressionStream('deflate-raw') is missing (iOS/macOS WebKit < 16.4). */
export function shareSupported(): boolean {
  if (typeof CompressionStream !== 'function' || typeof DecompressionStream !== 'function') {
    return false;
  }
  try {
    new CompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies `text` (may be a promise, so Safari keeps the click's user activation:
 * ClipboardItem with a promised Blob), falls back to writeText; false on failure.
 */
export async function copyToClipboard(
  text: Promise<string>,
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): Promise<boolean> {
  const clipboard = nav?.clipboard;
  if (!clipboard) return false;
  if (typeof ClipboardItem === 'function' && typeof clipboard.write === 'function') {
    try {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch {
      // fall through to writeText
    }
  }
  try {
    await clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}

/** "Before shared city – <date>" etc.; `template` has `{date}`. */
export function datedName(template: string, date: Date, locale: string): string {
  const formatted = date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return template.replace('{date}', formatted);
}

/**
 * Keeps `current` (if any) as a named save, then hands `shared` to `replace`.
 * If keeping fails it throws and `replace` is NOT called.
 */
export async function keepAndOpenShared(deps: {
  storage: Pick<SaveStorage, 'save'>;
  current: SaveGame | null;
  currentPopulation?: number;
  keptName: string;
  shared: SaveGame;
  replace: (save: SaveGame) => Promise<void>;
  newId?: () => string;
}): Promise<void> {
  const { storage, current, currentPopulation, keptName, shared, replace } = deps;
  if (current) {
    await storage.save(current, (deps.newId ?? newSlotId)(), keptName, currentPopulation);
  }
  await replace(shared);
}
