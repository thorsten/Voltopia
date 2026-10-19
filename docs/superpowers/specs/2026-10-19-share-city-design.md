# Share a city — Design

Date: 2026-10-19
Status: draft for review

## Goal

A city can only leave the device as an exported JSON file. Sharing a
city with someone means sending a file, which they then import on the
saves page. This feature packs the whole city into a link: opening it
loads the city, and the player's own city is kept as a save.

## Decisions (with the user, 2026-10-19)

- **Full city, compressed** (rejected: seed and settings only). The
  link carries the whole snapshot, deflated, in the URL hash.
- **Opening a link asks first and keeps the current city as a save**
  (rejected: only warning that the autosave will be replaced).
- Native app (no address bar): a "paste link" field on the saves page.
  Links created in the native app point to the public web build.

## Scope

In: fix the incomplete JSON export (first commit), a binary share codec
with deflate, creating and copying a link, opening a link on startup,
the paste-link import, agent tools, docs, i18n (en + de), tests.

Out: link shorteners or any server, QR codes, sharing scenario cities
(the share button is hidden during a scenario), thumbnails/preview
images, sharing the statistics history.

## Prerequisite fix: complete JSON export

`saveToJson` / `saveFromJson` (src/storage/serialization.ts) drop
`policies`, `finance`, `rules` and `scenario`. A file export therefore
loses loans, rating, ordinances and scenario state. Fix this:

- Add the four fields with validators in the existing style.
- Add a key-coverage test: build a `SaveGame` with every optional field
  set (from `serializeState` of a city that uses policies, credits and
  a scenario), round-trip it through JSON, and assert deep equality.
  The test must also fail when a future `SaveGame` field is added
  without serialization support.
- Plus `sandbox` once the sandbox branch is merged. If share-city is
  built first, the sandbox branch adds it.

One commit: `fix(storage): keep policies, finance, rules and scenario in exported saves`.

## Share codec

New module `src/storage/shareCode.ts` (DOM-free apart from the
`CompressionStream`/`DecompressionStream` globals, which exist in all
target browsers, in Node ≥ 18 and in WKWebView):

```ts
export async function encodeShareCode(save: SaveGame): Promise<string>;
export async function decodeShareCode(code: string): Promise<SaveGame>; // throws ShareCodeError
```

Format v1 (before compression):

1. Byte 0: format version `1`.
2. Bytes 1-4: length N of the header (uint32, little-endian).
3. N bytes: UTF-8 JSON of every `SaveGame` field except `layers` and
   `lifetime`. This reuses the JSON field handling of
   `saveToJson` without the base64 layers. A shared city starts with
   an empty history.
4. The layers as raw bytes, in a fixed, versioned order (the
   `SAVE_LAYERS` list). Each layer is `size²` bytes, so no lengths are
   needed.

The whole buffer is compressed with `deflate-raw` and encoded as
base64url without padding. Raw layers compress far better than the
base64 inside the JSON export, because the layers are mostly zeros
and long runs.

The decoder validates the following and throws `ShareCodeError` with a
reason (`format`, `version`, `corrupt`, `tooLarge`) on failure:

- the version;
- the header length;
- the decompressed size, limited to `size² × layer count + 1 MB`
  against zip bombs (decompression stops early);
- the header itself, through the existing `saveFromJson` validators.

The plan has to measure real sizes on probe cities (64 grown, 128
grown). Expectation: under 30 KB of link text for 64². If 128² is far
above 100 KB, the plan drops layers that can be regenerated from the
seed (terrain, elevation, geothermal) in a format v2. This is not
built speculatively.

## Creating a link

- **Saves page:** a "Share city" / "Stadt teilen" button next to
  export. It is hidden while a scenario runs.
- **Flow:** request a snapshot from the worker (existing save path) →
  `encodeShareCode` → URL = `SHARE_BASE_URL + '#city=' + code` → copy
  it to the clipboard (`navigator.clipboard.writeText`, with the
  Tauri clipboard as fallback if needed) → toast "Link copied (23 KB)".
  - Links over 64 KB get a warning: "Some apps shorten long links".
  - If the clipboard fails, a read-only text field with the link is
    shown.
- **`SHARE_BASE_URL`:**
  - web: `location.origin + import.meta.env.BASE_URL`;
  - native app: the constant `https://thorsten.github.io/Voltopia/` in
    `src/ui/platform.ts`.

## Opening a link

- **Startup** (App.tsx, before `storage.load()`): if `location.hash`
  starts with `#city=`, decode it.
  - The hash is removed immediately with `history.replaceState`, so a
    reload does not ask again.
  - Pending new-game options are ignored when a link is present.
- **Dialog** "Load shared city?" / "Geteilte Stadt laden?" shows the
  map size, the in-game day, the population and "Sandbox" if set.
  - **Load:** if an autosave exists, it is first stored as a named save
    "Before shared city – <date>" / "Vor geteilter Stadt – <Datum>"
    through the save catalogue. Then
    `cityReloader.replaceCityAndReload(save)` is called, so the
    existing autosave guard applies.
  - **Cancel:** the current city continues normally.
- **Invalid link:** a toast "This link does not contain a valid city"
  with the reason in the console; the game starts normally.
- **Paste-link import** (saves page, web and native): a text field plus
  an "Open" / "Öffnen" button. It accepts a full URL or just the code
  and goes through the same dialog.
- **Service worker:** the hash never reaches the server, so the PWA
  navigation fallback is unaffected. Verify this in e2e with the built
  app.

## Agent tools

- `share_city` returns `{ url, bytes }`.
- `open_shared_city { url }` adds the shared city as a named save
  ("Shared city – <date>") and returns its id. It does not load the
  city, because an agent should not replace the player's city without
  a `load_save`.
- docs/agent-tools.md is updated to match.

## Tests

- Unit:
  - codec round trip of a grown probe city (deep equality apart from
    `lifetime`);
  - rejects wrong version, truncated input, garbage, and an oversized
    decompressed buffer;
  - base64url has no `+ / =`.
- JSON fix: the key-coverage test (see above).
- e2e: build something → share → open the link in a new page → dialog
  → load → the city matches → the old city is listed on the saves
  page. Plus an invalid link shows the toast.

## Risks

- Very large cities make very long links. Mitigation: measure in the
  plan, warn above 64 KB, keep the v2 format as an option.
- `CompressionStream('deflate-raw')` in older WKWebView (iPadOS < 16.4)
  is not available. The minimum target of the Tauri iOS build has to
  be checked in the plan. If it is too old, fall back to `deflate`,
  which has wider support.
