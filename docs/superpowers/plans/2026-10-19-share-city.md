# Share a City Implementation Plan

> **For agentic workers:** Execute task by task, in order. Steps use checkbox (`- [ ]`) syntax. Each task ends with a green pre-commit hook and one commit.

**Goal:** Pack the whole city into a link (`…/#city=<code>`). Opening the link asks first, keeps the current city as a named save, then loads the shared city. A paste-link field on the saves page covers the native app. Agent tools `share_city` / `open_shared_city`. First, fix the JSON export so it stops dropping `policies`, `finance`, `rules`, `scenario` (and the `pvMandated` layer).

**Architecture:** `src/storage/serialization.ts` gets a typed, exhaustive field-reader table plus the canonical layer list `SAVE_LAYERS`. The compiler then rejects any `SaveGame` field that has no serialization support, and a round-trip test of a `Required<SaveGame>` fixture checks the same thing at run time. The new DOM-free module `src/storage/shareCode.ts` packs the city as `[version byte][uint32 LE header length][header JSON][raw layers in SAVE_LAYERS order]`, compresses it with `deflate-raw` and encodes it as base64url. The header JSON reuses `saveFieldsToJson` / `saveFieldsFromJson` and leaves out `layers` and `lifetime`. `src/ui/shareLink.ts` holds the pure UI glue: base URL, code extraction, reading the hash once, clipboard, and keeping the current city. The saves page shares and opens pasted links. `App` reads the hash before `storage.load()` and shows `SharedCityDialog` in place of the game. Loading still goes through `cityReloader.replaceCityAndReload`.

**Tech Stack:** TypeScript strict, vitest, React 19, i18n in `src/ui/i18n.tsx`, Playwright, `CompressionStream`/`DecompressionStream` (browser, WKWebView ≥ 16.4, Node ≥ 22 in CI). No new dependencies, no Tauri plugin.

**Spec:** `docs/superpowers/specs/2026-10-19-share-city-design.md`

**Prerequisite:** the sandbox-mode branch is merged first. It adds `SaveGame.sandbox?: boolean`, and its `saveFromJson` keeps only `sandbox: true`. Task 1 adds `sandbox` to the field table and the fixture, and the dialog in Task 4 shows "Sandbox" from it.

## Measured share-code sizes (probe, 2026-10-19)

A temporary `scripts/probe-share.mjs` (plain node importing the TS sim, now deleted) set up these cities through `SimEngine`: seed 7, a road grid every 5 rows and every 8 columns, every other row zoned (R/R/C/Retail/I by band), a solar/wind/battery plant every 16 columns, 50 M starting money, disasters off, 40 in-game days. It serialized each city with `serializeState`, built the v1 buffer (header JSON without `layers`/`lifetime` plus 20 raw layers) and compressed it with `CompressionStream`.

| City                                                                               | Raw v1 buffer | JSON export | deflate-raw | **link code (base64url)** | without terrain/elevation/geothermal |
| ---------------------------------------------------------------------------------- | ------------- | ----------- | ----------- | ------------------------- | ------------------------------------ |
| 64², 477 buildings, 2 459 residents                                                | 83 046 B      | 124 056 B   | 4 074 B     | **5 432 chars**           | 4 399 chars                          |
| 128², 1 801 buildings, 8 133 residents                                             | 328 871 B     | 451 942 B   | 12 630 B    | **16 840 chars**          | 13 599 chars                         |
| 128² worst case (every land tile a building, random zone/density/variant/supplied) | 328 kB        | –           | –           | **35 083 chars**          | –                                    |

- The header JSON is about 1.1 kB raw and about 600 B deflated.
- The noisiest layers are `variant` (random per building), `elevation` and `supplied`.
- `deflate`/`gzip` cost only 6–24 bytes more than `deflate-raw`.

**Decision: v1 is enough.** A grown 64² city is about 5 KB of link text (the target was under 30 KB). A grown 128² city is about 17 KB, and even the 128² worst case stays at about 35 KB, below the 64 KB warning. Dropping the seed-regenerable layers (v2) would save only 5–19 %, so v2 is not built.

## Global Constraints

- `src/storage/shareCode.ts` is DOM-free. The only browser globals it uses are `CompressionStream`, `DecompressionStream`, `Blob`, `Response`, `TextEncoder`/`TextDecoder`, `btoa`/`atob`, all of which exist in Node 22 (CI) and in the vitest `node` environment. No `window`, `location` or `navigator` in `src/storage/`.
- `SAVE_LAYERS` order is part of share format v1. It is **append-only**: never reorder or remove entries. The decoder takes the layer count from the payload length, so a newer build that appends a layer still reads older codes.
- `SAVE_VERSION` stays unchanged. A header whose `version` differs from `SAVE_VERSION` is rejected with reason `version`.
- `SaveGame` stays backward compatible (only optional fields are touched; there are no new fields).
- Every user-visible string lives in `src/ui/i18n.tsx`, English AND German.
- React effects depend on stable identities (`bridge.send`, `bridge.onSaveData`), never on the `bridge` object.
- **StrictMode runs boot effects twice.** Read the `#city=` hash once per page load through a module-level cache, in the same pattern as `consumePendingNewGame` (`src/ui/newGame.ts:71`). The second effect run would otherwise find the hash already stripped.
- Every replacement of the city goes through `cityReloader.replaceCityAndReload` (`src/ui/App.tsx:61`).
- New user-facing feature → agent tools + `docs/agent-tools.md` in the same task.
- Keep any single test under about 15 s. Run `pnpm format` before commits. The hook must be green; never use `--no-verify`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Adding a field to `SaveGame` (or a layer to `SaveGame['layers']`) without serialization support fails `pnpm typecheck` **and** the key-coverage test (Task 1).
2. A JSON export of a city with a scenario, a credit and an ordinance imports with all of them intact. Old exports without these fields still import unchanged (Task 1).
3. The decoder never allocates more than `SHARE_MAX_BYTES`. Every failure is a `ShareCodeError` with one of `format | version | corrupt | tooLarge`, never an uncaught `TypeError` (Task 2).
4. Opening a link can never lose the player's city. The current autosave (boot) or a live snapshot (saves page) is stored as a named save **before** `replaceCityAndReload`. If that save fails, the shared city is not loaded (Tasks 3–5).
5. The hash is stripped before the first `await`, so a reload, including `replaceCityAndReload`'s own reload, never asks twice (Task 5).

---

### Task 1: Complete JSON export — exhaustive field table, `SAVE_LAYERS`, key-coverage test

**Files:**

- Modify: `src/storage/serialization.ts` (whole file: `SaveGameJson` `:5`, `saveToJson` `:79`, `saveFromJson` `:228`, layer lists `:242` / `:263`)
- Modify: `src/storage/serialization.test.ts`
- Create: `src/test/saveFixtures.ts` (test helper, imported by tests only; `src/test/` already holds `yieldBetweenTests.ts`)

**Findings that shape this task:**

- `saveToJson` drops `policies`, `finance`, `rules`, `scenario` and the legacy `storedEnergy`.
- `saveFromJson` also never reads the **`pvMandated` layer**: it is missing from `optionalLayers` (`:263`) although `serializeState` writes it (`src/sim/state.ts:1395`). An exported city therefore loses its rooftop-PV-mandate markers. Fix it here as well.
- Deep sanitising already happens on load: `loadFinance` (`src/sim/finance.ts:365`) cleans every finance value, and `deserializeState` (`src/sim/state.ts:1509`) merges `rules` over `DEFAULT_RULES` and a known scenario over `emptyRun`. The JSON validators only need to guarantee the **shape** those loaders read, so they never crash on a hand-edited file.

**Interfaces (in `serialization.ts`):**

```ts
/** Canonical layer order. Share format v1 depends on it: APPEND ONLY. */
export const SAVE_LAYERS = [
  // required (present in every save since v1)
  'tileType',
  'roadMask',
  'zone',
  'density',
  'variant',
  'supplied',
  'plantType',
  // optional, in the order they were introduced
  'terrain',
  'powerLine',
  'elevation',
  'roadClass',
  'busStop',
  'forest',
  'geothermal',
  'reservoirHeat',
  'damage',
  'rail',
  'overpass',
  'roadLane',
  'pvMandated',
] as const satisfies readonly (keyof SaveGame['layers'])[];
export const REQUIRED_LAYER_COUNT = 7;
export type SaveLayerName = (typeof SAVE_LAYERS)[number];
// Compile-time exhaustiveness: a new layer key must be appended above.
type MissingLayer = Exclude<keyof SaveGame['layers'], SaveLayerName>;
const LAYERS_COMPLETE: [MissingLayer] extends [never] ? true : MissingLayer = true;
void LAYERS_COMPLETE;

type BaseKey = 'version' | 'seed' | 'size' | 'tick' | 'money' | 'taxRate' | 'layers';
type OptionalKey = Exclude<keyof SaveGame, BaseKey>;
/**
 * One reader per optional SaveGame field: returns the sanitised value or
 * undefined (= drop). `-?` makes every key mandatory here, so a new
 * SaveGame field without a reader is a type error.
 */
type FieldReaders = { [K in OptionalKey]-?: (value: unknown) => SaveGame[K] | undefined };

/** Every SaveGame field except `layers`, JSON-ready (no ArrayBuffers). */
export type SaveFields = Omit<SaveGame, 'layers'>;
export function saveFieldsToJson(save: SaveGame): SaveFields; // copies every key but layers
export function saveFieldsFromJson(parsed: unknown): SaveFields; // throws Error on bad base fields
export function saveToJson(save: SaveGame): string; // unchanged signature
export function saveFromJson(text: string): SaveGame; // unchanged signature
```

- **Writer:** `saveFieldsToJson` returns `{ ...save }` without `layers` (a rest copy). The writer is generic, so no field can ever be dropped on write again. `saveToJson` = `JSON.stringify({ ...saveFieldsToJson(save), layers: base64 per SAVE_LAYERS entry that is present }, null, 2)`. This also writes the legacy fields (`storedEnergy`, …) when a hand-built save carries them, which is harmless: `serializeState` never sets them.
- **Reader:** `saveFieldsFromJson(parsed)` checks the base fields exactly as `:230-240` does today (`version === SAVE_VERSION`, numeric `seed/size/tick/money`) and throws `Error('Not a valid Voltopia save file')`. It applies the `taxRate` default `0.1` and then runs `for (const key of Object.keys(FIELD_READERS))`, assigning only the values that are not `undefined`. `saveFromJson` = `JSON.parse` → the layer object check → `saveFieldsFromJson` → layers from `SAVE_LAYERS` (the first `REQUIRED_LAYER_COUNT` are required; sizes are checked as today).
- **Port every existing validator 1:1 into `FIELD_READERS`.** Reuse the helpers `num`, `finiteNum`, `bool`, `isStoredPairs`, `isSavedSmartMeters`, `isSavedDemandResponse`, `isSavedIslandPools`, `isSavedDisasters`, the per-train filter for `trains`, the string filter for `goals` and the `day` filter for `lifetime`. The existing 436-line `serialization.test.ts` guards that behaviour stays the same.
- **New readers:**
  - `policies`: a non-array object → `{ [id]: true }` for each `id` in `POLICY_IDS` (`src/shared/types.ts:164`) whose value is `true`. Unknown keys and non-booleans are dropped.
  - `finance`: a non-null, non-array object → passed through as `FinanceSave` (`loadFinance` sanitises every member). Anything else → `undefined`.
  - `rules`: an object with finite `importCapacityFactor >= 0` and `startSeason` in `SEASON_ORDER` (`types.ts:158`) → `{ importCapacityFactor, startSeason }`. Otherwise `undefined` (free-play defaults).
  - `scenario` (`isSavedScenario`): `id` is a string, `startTick` is finite, `status` ∈ `running|won|failed`, `endedTick` is absent or finite, `samples` is an object of finite-number arrays, `today` is an object whose six fields (`deficitTicks, importedEnergy, renewable, generation, suppliedShareSum, ticks`) are finite. All or nothing, with the same reasoning as `isSavedDisasters`.
  - `sandbox` (exists after the sandbox branch): keep its reader (`value === true ? true : undefined`).

**Key-coverage test design.** `src/test/saveFixtures.ts` exports `fullSave(): Required<SaveGame> & { layers: Required<SaveGame['layers']> }`:

- It takes `serializeState` of a 16² `createSimState(5, 16)`, with a road built, `state.policies.<first id> = true`, `takeCredit(state, 'loan', 5_000)` and `startScenario(state, scenarioDef(SCENARIO_IDS[0]))`. Importing `src/sim/scenarios/defs/index.ts` registers the defs.
- Spread over that, it explicitly sets **every** remaining key with a non-default value: legacy `smartCharging: true, storedEnergy: 3, pumpedStorageEnergy: 4, hydrogenEnergy: 5, heatStored: 6, flexBacklog: 7`, `sandbox: true`, `lifetime: [one sample]`, etc.
- The `Required<…>` return type makes a new `SaveGame` field a **type error** in the fixture until someone adds a value. `FieldReaders` makes it a type error in `serialization.ts` until someone adds a reader.

**Steps:**

- [ ] Write the failing tests in `serialization.test.ts`:
  - `'every SaveGame field survives the JSON round trip'`: `const save = fullSave(); const back = saveFromJson(saveToJson(save));` then `for (const key of Object.keys(save) as (keyof SaveGame)[]) if (key !== 'layers') expect(back[key], key).toEqual(save[key]);` and `for (const name of SAVE_LAYERS) expect(new Uint8Array(back.layers[name]!), name).toEqual(new Uint8Array(save.layers[name]));`.
  - `'SAVE_LAYERS lists every layer exactly once'`: `expect(new Set(SAVE_LAYERS).size).toBe(SAVE_LAYERS.length)` and `expect([...SAVE_LAYERS].sort()).toEqual(Object.keys(fullSave().layers).sort())`.
  - Scenario, credit and ordinance survive export → import → `deserializeState` (`state.scenario.id`, `state.finance.credits.length === 1`, `state.policies[id]`).
  - Malformed new fields are dropped, not thrown: `policies: { bogus: true, <id>: 'yes' }` → `{}`; `rules: { startSeason: 'monsoon' }` → absent; `scenario: { id: 'x' }` → absent; `finance: 7` → absent.
  - An old export without the four fields still imports (the existing tests already cover this; keep them green).
- [ ] Implement the refactor (field table, generic writer, `SAVE_LAYERS`, `pvMandated`).
- [ ] Prove the guard works: temporarily add `foo?: number` to `SaveGame`, check that `pnpm typecheck` fails in both `serialization.ts` and `saveFixtures.ts`, then revert.
- [ ] `pnpm typecheck && pnpm test` green; `pnpm format`; commit `fix(storage): keep policies, finance, rules and scenario in exported saves` (the body mentions the `pvMandated` layer and the exhaustive field table).

---

### Task 2: Share codec `src/storage/shareCode.ts`

**Files:** Create `src/storage/shareCode.ts` and `src/storage/shareCode.test.ts`.

**Code (target shape):**

```ts
import { SAVE_VERSION } from '../shared/constants.ts';
import type { SaveGame } from '../shared/types.ts';
import {
  REQUIRED_LAYER_COUNT,
  SAVE_LAYERS,
  saveFieldsFromJson,
  saveFieldsToJson,
} from './serialization.ts';

export const SHARE_FORMAT_VERSION = 1;
/** Largest map a share code may carry (the UI offers up to 128). */
export const SHARE_MAX_MAP_SIZE = 256;
const HEADER_OFFSET = 5; // version byte + uint32 header length
const HEADER_SLACK = 1 << 20; // 1 MB of header JSON at most
/** Zip-bomb guard: decompression stops beyond this many bytes. */
export const SHARE_MAX_BYTES =
  SHARE_MAX_MAP_SIZE * SHARE_MAX_MAP_SIZE * SAVE_LAYERS.length + HEADER_SLACK;
/** Codes longer than this are rejected before decoding (base64 of the cap's deflate bound). */
export const SHARE_MAX_CODE_LENGTH = 4 * 1024 * 1024;

export type ShareCodeErrorReason = 'format' | 'version' | 'corrupt' | 'tooLarge';

export class ShareCodeError extends Error {
  readonly reason: ShareCodeErrorReason;
  constructor(reason: ShareCodeErrorReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ShareCodeError';
    this.reason = reason;
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
    throw new ShareCodeError('format', 'not base64url');
  }
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates, aborting as soon as the output exceeds `limit` bytes. */
async function inflateRawLimited(
  bytes: Uint8Array<ArrayBuffer>,
  limit: number,
): Promise<Uint8Array> {
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new ShareCodeError('tooLarge');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ShareCodeError) throw error;
    throw new ShareCodeError('corrupt', String(error));
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function encodeShareCode(save: SaveGame): Promise<string> {
  // A shared city starts with an empty history.
  const header = new TextEncoder().encode(
    JSON.stringify({ ...saveFieldsToJson(save), lifetime: undefined }),
  );
  const area = save.size * save.size;
  const buffer = new Uint8Array(HEADER_OFFSET + header.length + SAVE_LAYERS.length * area);
  buffer[0] = SHARE_FORMAT_VERSION;
  new DataView(buffer.buffer).setUint32(1, header.length, true);
  buffer.set(header, HEADER_OFFSET);
  let offset = HEADER_OFFSET + header.length;
  for (const name of SAVE_LAYERS) {
    const layer = save.layers[name];
    if (layer) buffer.set(new Uint8Array(layer), offset); // absent → zeros = layer default
    offset += area;
  }
  return toBase64Url(await deflateRaw(buffer));
}

export async function decodeShareCode(code: string): Promise<SaveGame> {
  if (code.length > SHARE_MAX_CODE_LENGTH) throw new ShareCodeError('tooLarge');
  const bytes = await inflateRawLimited(
    fromBase64Url(code) as Uint8Array<ArrayBuffer>,
    SHARE_MAX_BYTES,
  );
  if (bytes.length < HEADER_OFFSET) throw new ShareCodeError('corrupt', 'too short');
  if (bytes[0] !== SHARE_FORMAT_VERSION) throw new ShareCodeError('version', `format ${bytes[0]}`);
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true);
  const layersStart = HEADER_OFFSET + headerLength;
  if (layersStart > bytes.length) throw new ShareCodeError('corrupt', 'header length');
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_OFFSET, layersStart)),
    );
  } catch (error) {
    throw new ShareCodeError('corrupt', String(error));
  }
  if ((header as { version?: unknown } | null)?.version !== SAVE_VERSION) {
    throw new ShareCodeError('version', 'save version');
  }
  let fields;
  try {
    fields = saveFieldsFromJson(header);
  } catch (error) {
    throw new ShareCodeError('corrupt', String(error));
  }
  const { size } = fields;
  if (!Number.isInteger(size) || size < 1 || size > SHARE_MAX_MAP_SIZE) {
    throw new ShareCodeError('corrupt', `size ${size}`);
  }
  const area = size * size;
  const layerBytes = bytes.length - layersStart;
  const count = layerBytes / area;
  if (!Number.isInteger(count) || count < REQUIRED_LAYER_COUNT || count > SAVE_LAYERS.length) {
    throw new ShareCodeError('corrupt', 'layer bytes');
  }
  const layers = {} as SaveGame['layers'];
  for (let i = 0; i < count; i++) {
    const start = layersStart + i * area;
    layers[SAVE_LAYERS[i]] = bytes.slice(start, start + area).buffer;
  }
  const { lifetime: _dropped, ...rest } = fields; // see note: or `delete`
  return { ...rest, layers };
}
```

Notes:

- `saveFieldsFromJson` may throw a plain `Error`; the codec wraps it as `corrupt`.
- If oxlint flags the unused `_dropped`, write `const result = { ...fields, layers }; delete result.lifetime; return result;` instead.
- `Uint8Array<ArrayBuffer>` casts are only needed if TS 5.9's `BlobPart` typing complains. Check with `pnpm typecheck` and drop them if not.

**Steps:**

- [ ] Write the failing tests in `shareCode.test.ts`:
  - **Round trip of a grown city:** `new SimEngine(3, 32)` with `init` (`disasterScale: 0`), a road line and zones beside it, a solar farm, then `advance` about 1 500 ticks so a few buildings stand (keep the test under 3 s). Also add a credit and an ordinance. Decode `encodeShareCode(serializeState(state))`. Every `SaveGame` key except `lifetime` must equal the original (use the key loop from Task 1), and `decoded.lifetime` must be `undefined`. Every `SAVE_LAYERS` buffer must be byte-equal. `deserializeState(decoded)` must give the same `countPopulationAndJobs` as the original.
  - **`fullSave()` round trip** (Task 1 fixture): every key except `lifetime` survives.
  - **base64url only:** the code matches `/^[A-Za-z0-9_-]+$/` (no `+ / =`).
  - **Rejections:** wrong format byte (re-pack with byte 0 = 2) → `version`. A header with `version: SAVE_VERSION + 1` → `version`. A truncated code (`code.slice(0, code.length / 2)`) → `corrupt` (or `format` when the length is ≡ 1 mod 4: assert `reason` ∈ `{format, corrupt}`). `'!!!'` → `format`. Valid deflate of `'hello'` → `corrupt`. A layer section of `area * 6` bytes → `corrupt`.
  - **Zip bomb:** deflate `[1, len(header)…, header, then SHARE_MAX_BYTES zero bytes]` → `tooLarge`. Build it in chunks with a `ReadableStream` so the test does not allocate it twice, and keep it under 2 s.
  - **Oversized code string** (`'A'.repeat(SHARE_MAX_CODE_LENGTH + 1)`) → `tooLarge` without decoding.
  - Every thrown error is `instanceof ShareCodeError`.
- [ ] Implement.
- [ ] Green; format; commit `feat(storage): compact share code for whole cities`.

---

### Task 3: Share-link glue (pure, unit-tested) and population from layers

**Files:**

- Create: `src/ui/shareLink.ts`, `src/ui/shareLink.test.ts`
- Modify: `src/ui/platform.ts` (add the constant), `src/storage/summary.ts` (+ test in `summary.test.ts`)

**Interfaces:**

```ts
// platform.ts
/** Where links made in the native app point (it has no URL of its own). */
export const PUBLIC_WEB_URL = 'https://thorsten.github.io/Voltopia/';

// summary.ts — same arithmetic as countPopulationAndJobs (src/sim/state.ts:1697), from raw layers
export function populationOfSave(save: SaveGame): number;

// shareLink.ts
export const SHARE_HASH_PREFIX = '#city=';
/** Links above this length get the "some apps shorten long links" warning. */
export const SHARE_LINK_WARN_LENGTH = 64 * 1024;
export function shareBaseUrl(deps?: { native?: boolean; origin?: string; base?: string }): string;
//   native → PUBLIC_WEB_URL; web → new URL(base ?? import.meta.env.BASE_URL, origin ?? location.origin).href
export function shareUrl(code: string, base?: string): string; // base + '#city=' + code
/** Accepts a full link, a bare '#city=…' or just the code; trims whitespace; null when nothing usable. */
export function extractShareCode(input: string): string | null;
/**
 * The '#city=' code of this page load, read ONCE (StrictMode-safe cache like
 * consumePendingNewGame); strips the hash via history.replaceState on first read.
 */
export function takeShareCodeOnce(
  loc?: Pick<Location, 'hash' | 'pathname' | 'search'>,
  hist?: Pick<History, 'replaceState' | 'state'>,
): string | null;
export function resetShareCodeCacheForTests(): void;
/** False where CompressionStream('deflate-raw') is missing (iOS/macOS WebKit < 16.4). */
export function shareSupported(): boolean;
/**
 * Copies `text` (may be a promise, so Safari keeps the click's user activation:
 * ClipboardItem with a promised Blob), falls back to writeText; false on failure.
 */
export async function copyToClipboard(text: Promise<string>, nav?: Navigator): Promise<boolean>;
/** "Before shared city – <date>" etc.; `template` has `{date}`. */
export function datedName(template: string, date: Date, locale: string): string;
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
}): Promise<void>;
```

- `extractShareCode`: `const i = input.indexOf('#city=')`; if found, take the rest. Otherwise, if the trimmed input matches `/^[A-Za-z0-9_-]{16,}$/`, take it as the code. Otherwise `null`.
- `takeShareCodeOnce`: if `loc.hash.startsWith(SHARE_HASH_PREFIX)`, call `hist.replaceState(hist.state, '', loc.pathname + loc.search)` **before** returning. Cache the result, including `null`.
- `populationOfSave`: loop over `tileType`/`zone`/`density` with `BALANCE.growth.populationByDensity`, counting only `TileType.Empty` tiles in the residential zone. `src/storage` may import `src/shared/constants.ts` but not `src/sim/`.

**Clipboard note:** the Tauri app has no clipboard plugin (`src-tauri/capabilities/default.json` grants only core/opener/dialog/fs). WKWebView supports `navigator.clipboard.write` with a `ClipboardItem` holding a promise when it runs inside the click. So the plan adds **no** Tauri clipboard plugin (that would need a Rust crate, a capability and an `allowBuilds` check). The read-only link field covers every remaining failure.

**Steps:**

- [ ] Failing tests:
  - `shareBaseUrl` covers native → `PUBLIC_WEB_URL`, web root `http://127.0.0.1:5199` + `/` → `http://127.0.0.1:5199/`, and GitHub Pages base `/Voltopia/`.
  - `extractShareCode` handles a full URL, `#city=` alone, a bare code, surrounding whitespace, a URL without a hash → `null`, and `''` → `null`.
  - `takeShareCodeOnce` strips via `replaceState` (called with `'/Voltopia/'` and the search kept), and a second call returns the cached code without calling `replaceState` again.
  - `copyToClipboard` resolves `true` via `write`. It falls back to `writeText` when `ClipboardItem` is undefined or `write` rejects, and returns `false` when both reject. Use stub navigators.
  - `keepAndOpenShared` with a memory storage (`createMemoryStorage`): the kept save appears in `list()` under the given name, and `replace` gets `shared`. With `current: null` nothing is saved. When `storage.save` rejects, `replace` is not called and the error propagates.
  - `populationOfSave(serializeState(state))` equals `countPopulationAndJobs(state).population` on a city with a few grown houses (import the sim in the test only).
- [ ] Implement.
- [ ] Green; format; commit `feat(ui): share-link helpers, clipboard with fallback and save population from layers`.

---

### Task 4: Saves page — share button, paste-link field, `SharedCityDialog`

**Files:**

- Create: `src/ui/SharedCityDialog.tsx`
- Modify: `src/ui/SavesPage.tsx` (export block `:163`, transfer section `:314`), `src/ui/App.tsx` (SavesPage mount `:480`: new props), `src/ui/i18n.tsx` (EN `:553` area, DE `:1354` area), `src/ui/app.css`

**`SharedCityDialog`** (uses `Modal`, `testId="shared-city-dialog"`):

```tsx
export function SharedCityDialog(props: {
  save: SaveGame;
  busy?: boolean;
  error?: string | null;
  onLoad: () => void;
  onCancel: () => void;
}): JSX.Element;
```

- It shows `t('share.dialogDetails', { map: `${size}×${size}`, day: dayOfTick(save.tick), population: populationOfSave(save) })` in `data-testid="shared-city-details"`.
- When `save.sandbox === true` it adds a badge `data-testid="shared-city-sandbox"` with `t('share.sandbox')`.
- A note says the current city is kept as a save (`share.keepNote`).
- Buttons: `shared-city-load` (disabled while busy) and `shared-city-cancel`. The error line is `shared-city-error`.

**SavesPage additions** (new props: `canShare: boolean` = `!stats.scenario`, `currentPopulation` is the existing `population`):

- In the "Backup" section, next to `export-save`: when `canShare && shareSupported()`, show the button `data-testid="share-city"` with `t('share.button')`.
  - On click it calls `copyToClipboard(linkPromise)`, where `linkPromise = requestSnapshot().then(encodeShareCode).then((c) => shareUrl(c))`. It creates the promise **synchronously in the click handler**, so the clipboard call still runs inside the user activation.
  - On success: `setMessage(t('share.copied', { size: Math.max(1, Math.round(url.length / 1024)) }))`, plus `t('share.long')` when `url.length > SHARE_LINK_WARN_LENGTH`.
  - On failure: show a read-only `<input data-testid="share-link-output" value={url} readOnly onFocus={(e) => e.currentTarget.select()} />` with `t('share.copyFailed')`.
- Below it, show a paste row (a form) when `shareSupported()`:
  - `<input data-testid="share-open-input" placeholder={t('share.openLabel')} />` and a submit button `share-open` with `t('share.open')`.
  - On submit: `extractShareCode` → `decodeShareCode`. On failure: `setMessage(t('share.invalid'))` and `console.warn(error)`. On success: `setShared(save)`, which renders `SharedCityDialog`. Render it **instead of** the saves Modal (return early) so there are not two backdrops.
- Dialog `onLoad` (saves page path, the running city always exists): `run(async () => keepAndOpenShared({ storage, current: await requestSnapshot(), currentPopulation: population, keptName: datedName(t('share.keptName'), new Date(), locale), shared, replace: replaceCityAndReload }))`. `onCancel` → `setShared(null)`.

**i18n keys (EN / DE):**

- `share.button`: 'Share city' / 'Stadt teilen'
- `share.copied`: 'Link copied ({size} KB).' / 'Link kopiert ({size} KB).'
- `share.long`: 'Some apps shorten long links.' / 'Manche Apps kürzen lange Links.'
- `share.copyFailed`: 'Copying failed – copy the link below.' / 'Kopieren fehlgeschlagen – kopiere den Link unten.'
- `share.linkLabel`: 'Share link' / 'Link zum Teilen'
- `share.openLabel`: 'Paste a city link' / 'Stadt-Link einfügen'
- `share.open`: 'Open' / 'Öffnen'
- `share.invalid`: 'This link does not contain a valid city.' / 'Dieser Link enthält keine gültige Stadt.'
- `share.dialogTitle`: 'Load shared city?' / 'Geteilte Stadt laden?'
- `share.dialogDetails`: 'Map {map} · day {day} · {population} residents' / 'Karte {map} · Tag {day} · {population} Einwohner'
- `share.sandbox`: 'Sandbox' / 'Sandbox'
- `share.keepNote`: 'Your current city is kept as a save.' / 'Deine aktuelle Stadt bleibt als Spielstand erhalten.'
- `share.load`: 'Load' / 'Laden'
- `share.cancel`: 'Cancel' / 'Abbrechen'
- `share.keptName`: 'Before shared city – {date}' / 'Vor geteilter Stadt – {date}'

**Steps:**

- [ ] Implement the dialog, the saves page changes, the i18n keys and the CSS (reuse `.saves-row` / `.saves-input`; the badge reuses an existing pill style if there is one).
- [ ] `pnpm typecheck && pnpm test` (`de: Record<TranslationKey, string>` makes a missing German key a type error). Run `node scripts/smoke.mjs` if it runs in the sandbox.
- [ ] Format; commit `feat(ui): share a city from the saves page and open pasted links`.

---

### Task 5: Open a link on startup

**Files:** Modify `src/ui/App.tsx` (boot effect `:84-94`, `App` render `:96-99`, `Game` props `:122`, toast near `:429`), `src/ui/i18n.tsx` (if a key is still missing), `src/ui/app.css` (`.notice-toast`, the same box as `.rejection-toast` at `:554` in a neutral colour).

**Boot flow (`App`):**

```ts
const [boot, setBoot] = useState<{
  save: SaveGame | null; // the autosave
  options: NewGameOptions;
  shared: SaveGame | null; // decoded link, awaiting the dialog
  linkFailed: boolean;
} | null>(null);

useEffect(() => {
  let cancelled = false;
  const code = takeShareCodeOnce(); // strips the hash before any await
  const decoded = code
    ? decodeShareCode(code).then(
        (save) => save,
        (error) => {
          console.warn('Shared city link rejected', error);
          return 'failed' as const;
        },
      )
    : Promise.resolve(null);
  void Promise.all([storage.load(), decoded]).then(([save, shared]) => {
    const pending = consumePendingNewGame(); // always consumed (cached per load)
    // A link wins over pending new-game options.
    const options = shared && shared !== 'failed' ? { ...DEFAULT_NEW_GAME } : pending;
    if (!cancelled)
      setBoot({
        save,
        options,
        shared: shared === 'failed' ? null : shared,
        linkFailed: shared === 'failed',
      });
  });
  return () => {
    cancelled = true;
  };
}, []);
```

- While `boot.shared` is set, `App` renders the boot screen plus `<SharedCityDialog>`, and `Game` is **not** mounted. With no worker and no autosave interval running, nothing can race the replacement.
  - **Load:** `keepAndOpenShared({ storage, current: boot.save, keptName: datedName(t('share.keptName'), new Date(), locale), shared: boot.shared, replace: cityReloader.replaceCityAndReload })`. The kept save's population comes from `summarizeSave`'s lifetime fallback, which is fine for an autosave. On an error, show it in the dialog (`error` prop) and keep the dialog open.
  - **Cancel:** `setBoot({ ...boot, shared: null })` → `Game` mounts with the autosave as today.
- `linkFailed` → `Game` gets a `notice` prop and shows `<div className="notice-toast" data-testid="share-invalid">{t('share.invalid')}</div>` for 6 s. Use a `setTimeout` in an effect with an empty dependency list.
- `shareSupported() === false` with a code present → treat it as `linkFailed` (the toast). Log `'unsupported'` to the console.

**Steps:**

- [ ] Implement it. Check by hand with `pnpm dev` if available: open `/#city=<code from the saves page>`. The dialog appears, the hash is gone, Cancel keeps the city, and Load reloads into the shared city with the old one listed as "Before shared city – …". If the sandbox has no WebGL, the boot screen and dialog still render, because they are DOM only.
- [ ] `pnpm typecheck && pnpm test`; format; commit `feat(ui): open a shared city link on startup and keep the current city`.

---

### Task 6: Agent tools and docs

**Files:** `src/agent/tools.ts` (`AgentSaves` `:80`, `createAgentSaves` `:100`, tools after `load_save` `:1739`), `src/agent/tools.test.ts` (harness `:67-94`, read-only count `:212`), `src/ui/useAgentTools.ts` (`createAgentSaves` call), `docs/agent-tools.md` (table after `load_save`, line 202).

**Interfaces:**

```ts
// AgentSaves
share(): Promise<{ url: string; bytes: number }>;                 // snapshot → encode → shareUrl
importShared(input: string, name: string): Promise<SaveSummary>;  // extract → decode → storage.save(new id, name, populationOfSave)
// createAgentSaves deps
shareBaseUrl(): string;   // app: () => shareBaseUrl(); tests: () => 'http://test/'
```

- `share_city`:
  - Description: "Pack the running city into a link (`…#city=<code>`) that opens it in Voltopia. Returns `url` and `bytes` (link length). The history is not included. Not available during a scenario."
  - Annotations: `readOnlyHint: true`.
  - If `getStats()?.scenario` is set → `{ ok: false, error: 'scenarioRunning', message }`. If `!shareSupported()` → `{ ok: false, error: 'unsupported' }`.
- `open_shared_city { url: string }` (a full link or a bare code):
  - Description: "Add the city from a share link as a named save ('Shared city – <date>') and return its id. Does NOT load it — call load_save to switch."
  - Not read-only, not consequential.
  - On a `ShareCodeError` → `{ ok: false, error: 'invalidShareLink', reason }`. Otherwise `{ ok: true, id, name, save: summary }`.
  - The name is `'Shared city – ' + new Date().toISOString().slice(0, 10)`. Agent strings are English, like `defaultSaveName`.

**Steps:**

- [ ] Failing tests with the headless harness:
  - `share_city` returns a URL starting with the base and containing `#city=`, with `bytes === url.length`.
  - `open_shared_city` with that URL adds a save whose `list_saves` entry has the right `size`, `day` and `population`.
  - `load_save` on it then calls `replaceCity` with a save equal to the original (minus lifetime).
  - Garbage → `invalidShareLink` with `reason`.
  - During a scenario (`start_scenario` harness path, or set `state.scenario` through the engine) `share_city` → `scenarioRunning`.
  - Update the tool-list test (`:200-216`): the names include the two new tools, and the read-only count goes from 10 to 11.
- [ ] Implement; wire `shareBaseUrl` in `useAgentTools.ts`.
- [ ] Add `docs/agent-tools.md` rows for `share_city` (read) and `open_shared_city` (write), plus a sentence under "Conventions" that links are opened by humans through the dialog and by agents through `open_shared_city` + `load_save`.
- [ ] Green; format; commit `feat(agent): share_city and open_shared_city tools`.

---

### Task 7: End-to-end tests, service-worker check, docs

**Files:** `e2e/game.spec.ts` (new tests after the saves test at `:633`), `docs/idea.md` (Next ideas → share city done, with the measured sizes), `docs/plan.md` (one line), `README.md` (feature list).

**e2e 1 — `'a shared city opens from its link and the old city is kept'`** (`test.setTimeout(120_000)`):

1. `await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5199' })`.
2. Using the `voltopia.call` helper pattern (`:334-338`): `set_speed 0`, then `find_tiles empty_land` and `place_plant biogas` on the first tile that works (the same loop as `:340-349`). Remember the tile `{x, y}` and `readTick`.
3. Open the saves page → `share-city` → expect `saves-message` to contain `/Link copied|Link kopiert/`. Read `url = await page.evaluate(() => navigator.clipboard.readText())`. If the clipboard is not readable in CI, use the `share-link-output` field when it is visible. Expect `url` to match `/#city=[A-Za-z0-9_-]+$/`.
4. Change the running city so it differs from the shared one: `bulldoze` the plant, then `Control+s` and `waitForTimeout(500)`.
5. `await page.goto('about:blank'); await page.goto(url);`. A plain hash navigation would not reload the page.
6. Expect `shared-city-dialog` to be visible and `shared-city-details` to contain `64×64` (the default size; read it from `get_game_overview.gridSize` before sharing) and `day`. Expect `page.url()` to have no `#city=`.
7. Click `shared-city-load`, then expect `money` to be visible (15 s timeout). `inspect_tile {x, y}` must report the biogas plant again, and the tick must be ≈ the shared tick (paused; use `toBeLessThan(sharedTick + 60)`).
8. Open the saves page: a row whose name matches `/Before shared city|Vor geteilter Stadt/` exists.

**e2e 2 — `'an invalid city link shows a notice and the game starts normally'`:** `goto('about:blank')`, then `goto('/#city=notavalidcode')` → `share-invalid` is visible, then `money` is visible and the URL has no hash.

**e2e 3 — paste field:** in the saves page, fill `share-open-input` with garbage → `share-open` → `saves-message` shows the invalid text. (Valid paste is covered by Task 6's unit tests and e2e 1's dialog.)

**Service worker check (built app, not committed):** `pnpm build && pnpm preview --host 127.0.0.1 --port 5200 --strictPort`. Run e2e 1 and 2 against it with a temporary `/tmp/playwright.preview.config.ts` (`baseURL` `http://127.0.0.1:5200`, `reuseExistingServer`, `testDir` pointing at the repo's `e2e/`, `grep: /shared city|city link/`). Load once so the SW installs, then reload with a `#city=` link: the dialog must still appear. If the sandbox Chromium cannot run it, note in the commit body that it needs the Mac/CI.

**Steps:**

- [ ] Write the three tests. Run `pnpm e2e --grep "city link|shared city"` against the sandbox Chromium if possible; otherwise note that they need the Mac/CI.
- [ ] Do the SW check above.
- [ ] Docs:
  - `docs/idea.md`: the share-city entry → done, with the probe numbers (64² ≈ 5 KB, 128² ≈ 17 KB, worst 128² ≈ 35 KB).
  - `docs/plan.md`: one line.
  - README: "Share a city as a link".
  - The `docs/agent-tools.md` rows were already added in Task 6.
- [ ] Set `bundle.iOS.minimumSystemVersion` to `"26.0"` in `src-tauri/tauri.conf.json` (user decision) and mention the iOS 26 minimum in the native-app section of `docs/plan.md`.
- [ ] Format; commit `test(e2e): share a city and open it from the link`.

## Self-review notes

- **iOS deployment target vs `CompressionStream`:**
  - `src-tauri/tauri.conf.json` sets `bundle.iOS.minimumSystemVersion: "15.0"` and `macOS.minimumSystemVersion: "12.0"`.
  - `CompressionStream` and `DecompressionStream` shipped in WebKit **16.4 with all three formats at once** (`gzip`, `deflate`, `deflate-raw`). The spec's fallback from `deflate-raw` to `deflate` therefore **would not help**; this plan drops it.
  - Instead, `shareSupported()` feature-detects. On older WebKit the share button and the paste field are hidden, and an incoming link shows the invalid/unsupported notice. macOS 12 gets Safari 16.4+ WebKit through system updates.
  - Decided by the user (2026-10-19): the iOS minimum becomes **26.0**. Task 7 sets `bundle.iOS.minimumSystemVersion: "26.0"` in `src-tauri/tauri.conf.json` (macOS stays 12.0) and notes it in docs/plan.md's native-app section. `shareSupported()` stays for old web browsers.
  - Public web URL confirmed: `https://thorsten.github.io/Voltopia/`.
- **Spec deviations:**
  - (1) No `deflate` fallback (see above).
  - (2) No Tauri clipboard plugin. `ClipboardItem` with a promised Blob keeps Safari/WKWebView's user activation across the snapshot and compression, and the read-only field is the final fallback.
  - (3) The decoder derives the layer count from the payload length (`REQUIRED_LAYER_COUNT … SAVE_LAYERS.length`), so appending a layer later needs no format bump. This is a strict superset of the spec's fixed-order rule.
  - (4) Task 1 also fixes the missing `pvMandated` layer in `saveFromJson` and writes the legacy fields, so "every field round-trips" holds without exceptions.
  - (5) On startup, the dialog replaces the game view instead of floating above a running game. Nothing ticks or autosaves until the player decides, and Cancel mounts the game as usual.
  - (6) The spec's "toast" on the saves page is the existing `saves-message` line, and the startup notice is a new `notice-toast`. There is no generic toast system.
  - (7) The dialog's population comes from the layers (`populationOfSave`), because the shared city carries no history. The same function supplies the summary population of shared saves.
- **Security:**
  - The code is untrusted input. It is length-capped before base64 decoding and output-capped during inflation (`SHARE_MAX_BYTES` ≈ 2.3 MB).
  - Its header goes through the same validators as file imports, and the sim's own loaders (`loadFinance`, `deserializeState`) sanitise values.
  - Map size is capped at 256, and layer bytes must tile exactly.
  - Nothing from the code is ever rendered as HTML.
- **`SHARE_BASE_URL` for native** is `https://thorsten.github.io/Voltopia/`, derived from `origin git@github.com:thorsten/Voltopia.git` and the deploy's `VOLTOPIA_BASE=/Voltopia/`. Confirm that this is the live Pages URL (no custom domain).
- **Two tabs:** a second tab still running the old city could autosave over the shared city after the reload. This is the same risk as loading a save today and is out of scope. e2e 1 avoids it by navigating the same page.
- **Per-tick cost:** none. Everything runs on the main thread on demand. Encoding a 128² city is one snapshot plus about 330 kB through `CompressionStream` (milliseconds).
