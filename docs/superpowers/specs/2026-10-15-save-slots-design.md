# Save slots — Design

Date: 2026-10-15
Status: approved for planning

## Goal

Today the city lives in one autosave. The settings page also offers
three fixed, unnamed slots (save and load only) and an export/import
of the running city, where an import immediately replaces the autosave.
A player who wants to keep several cities, branch off before a risky
build or archive a finished town has no overview and no way to delete.

This feature replaces the three slots with a free list of named saves
on their own page, with load, overwrite, rename, delete and per-save
export, an import that adds a save instead of loading it, and agent
tools with the same reach.

## Decisions (with the user, 2026-10-15)

- **Free list of named saves** (rejected: extending the fixed slots).
  Any number of entries, newest first; each shows name, real-world save
  time, in-game day, population and money. The old `slot1`..`slot3`
  carry over as entries named "Slot 1".."Slot 3".
- **Own page** "Saves" / "Spielstände" (rejected: keep it in the
  settings). A footer button next to Settings opens it; export and
  import move there too, and the settings page keeps sound, graphics
  and theme only.
- **Agent tools** `list_saves`, `save_to_slot`, `load_save`,
  `delete_save` for feature parity; `load_save` reloads the page like
  `start_new_city`.

## Scope

In: storage catalogue with metadata, migration of the three legacy
slots, the saves page, export/import per entry, a guard against the
autosave overwriting a just-loaded city, agent tools and their docs,
i18n (en + de), unit and e2e tests.

Out: cloud sync, thumbnails/screenshots of the city, sharing via URL
(separate idea), several autosaves/rotation, saving from the
new-game dialog. No `SAVE_VERSION` bump: the `SaveGame` format does
not change.

## Storage

### Data model

`src/storage/storage.ts` gains a summary type and two methods:

```ts
export interface SaveSummary {
  /** Storage key; `autosave` is never listed. */
  id: string;
  name: string;
  /** Real-world save time, ms since epoch. */
  savedAt: number;
  /** In-game day (1-based) at save time. */
  day: number;
  population: number;
  money: number;
  size: number;
  /** False when the stored save has another SAVE_VERSION: delete only. */
  compatible: boolean;
}

export interface SaveStorage {
  load(slot?: string): Promise<SaveGame | null>;
  save(game: SaveGame, slot?: string, name?: string): Promise<void>;
  clear(slot?: string): Promise<void>;
  /** Named saves, newest first; never the autosave. */
  list(): Promise<SaveSummary[]>;
  rename(slot: string, name: string): Promise<void>;
}
```

`save()` with a name writes or replaces the summary; without a name on
an existing named slot it keeps the old name (overwrite); the autosave
has no summary. `clear()` removes save and summary together.

### Summaries without loading the grids

Listing must not deserialise every city (a 128² save carries several
layers). IndexedDB gets `DB_VERSION` 2 with a second object store
`summaries` (same key as `saves`). Save and summary are written in one
transaction across both stores, so a crash never leaves one without
the other.

`summarizeSave(save, name, savedAt)` in `src/storage/summary.ts` is a
pure function: day = `floor(tick / TICKS_PER_DAY) + 1`, population
from the last `lifetime` sample (0 when there is none, i.e. day 1),
money and size from the save, `compatible` = `version === SAVE_VERSION`.

### Migration

The `onupgradeneeded` step from version 1 to 2 creates `summaries` and,
for each existing `slot1`..`slot3`, writes a summary named "Slot N"
with `savedAt` = upgrade time (the original time is unknown). This
runs inside the upgrade transaction; there is no lazy fallback.

### New slot ids

`newSlotId()` returns `save-<Date.now() base36>-<4 random base36>`.
UI randomness, not sim randomness — the seeded `Rng` rule does not
apply. Legacy ids keep their `slotN` keys.

### Testability

No IndexedDB in node and no `fake-indexeddb` dependency: the catalogue
logic (summary bookkeeping, rename, newest-first ordering, overwrite
keeping the name) lives in `src/storage/catalog.ts` over a tiny
two-store key/value interface, implemented by the IndexedDB adapter
and by an in-memory `MemoryStorage` used in unit and agent-tool tests.
The upgrade step is a pure function over that interface too, so the
migration is unit-tested.

## Loading and the autosave guard

Loading a save copies it into the autosave slot and reloads, as today.
Today the interval autosave or the `visibilitychange` save can land
between the copy and the reload and write the old city back. A module
flag in `App.tsx` (`leaving`) is set before any copy/clear + reload
(load, import-and-load, new game, `start_new_city`, `load_save`); the
`onSaveData` handler and the native-close persist skip writing while
it is set. One helper `replaceCityAndReload(save | null)` does flag,
write/clear and reload for all callers.

## Saves page (`src/ui/SavesPage.tsx`)

Modal with `testId="saves-page"`, opened from a new footer button
`open-saves` ("Saves" / "Spielstände") between Imprint and Settings.

- **Save current city**: name field prefilled with
  "<city> – day N" (i18n key with placeholders; city = "Voltopia"),
  button "Save as new". The snapshot comes from `requestSnapshot()`;
  the summary uses the live `stats.population` so the list is not a
  day behind.
- **List**, newest first, one row per save: name, `savedAt` formatted
  with the locale (`Intl.DateTimeFormat`), "Day N · population ·
  money" with the existing number formatting, map size. Buttons:
  Load, Overwrite, Rename (inline text field, Enter/blur commits,
  Escape cancels, empty names rejected), Export, Delete.
  Overwrite and Delete use a two-step confirm in place (the button turns
  into "Really overwrite?" / "Really delete?" for 4 s), no
  `window.confirm` (unreliable in WKWebView).
  Incompatible entries show a hint and only offer Delete.
- **Empty state**: one line of help text.
- **Backup**: "Export current city" (as today) and "Import save file".
  An import is validated with `saveFromJson`, then added as a new
  entry named after the file name (without `.json`) and highlighted;
  it does not load. Errors show as the page message, as today.
- Export file name: `voltopia-<slug(name)>-<YYYY-MM-DD>.json`; the
  current-city export keeps `voltopia-save-<date>.json`.

The settings page loses its "Save slots" and "Backup" sections and the
`storage`/`requestSnapshot` props. Help text (`help.*`) gains one line
about the saves page; the Ctrl+S quick-save still targets the
autosave.

Tests: `data-testid`s `saves-page`, `save-name-input`, `save-new`,
`save-row-<id>`, `save-load-<id>`, `save-overwrite-<id>`,
`save-rename-<id>`, `save-export-<id>`, `save-delete-<id>`,
`import-save`, `export-save`.

## Agent tools

`AgentContext` gets a `saves` member:

```ts
saves: {
  list(): Promise<SaveSummary[]>;
  /** Snapshot the running city into a slot; new slot when id is omitted. */
  saveCurrent(name: string | null, id?: string): Promise<SaveSummary>;
  /** Copy into the autosave and reload (does not return in the app). */
  load(id: string): Promise<void>;
  delete(id: string): Promise<void>;
};
```

- `list_saves` (read-only): the summaries.
- `save_to_slot` `{ name?: string, id?: string }`: without `id` a new
  save (name defaults like the UI), with `id` overwrite of that save
  (unknown id → `ToolInputError`). Returns the summary.
- `load_save` `{ id }` (consequential): rejects unknown or
  incompatible ids, else loads; the page reloads.
- `delete_save` `{ id }` (consequential): unknown id → error.

`save_game` keeps its meaning (autosave now). In the app,
`useAgentTools` wires `saves` to the storage and the snapshot helper;
tests wire it to `MemoryStorage` and the headless `SimEngine`.
`docs/agent-tools.md` gets the four rows.

## i18n

New `saves.*` keys in English and German (title, footer button, save
as new, default name, load, overwrite, rename, export, delete, the two
confirms, incompatible hint, empty state, imported, saved, day/
population line); the `settings.saveSlots`/`settings.slot`/
`settings.save`/`settings.load`/`settings.saved` keys go away,
`settings.transfer`/`export`/`import` move to `saves.*`.

## Testing

- Unit: `summarizeSave`; catalogue (save with name, overwrite keeps
  the name, rename, clear removes both, list newest first, autosave
  never listed, incompatible flag); the v1→v2 migration over
  `MemoryStorage`; slug + file name; agent tools against
  `MemoryStorage` + `SimEngine` (save, list, overwrite, delete,
  unknown ids, load calls the reload hook).
- e2e (`e2e/game.spec.ts`): save the city under a name, rename it,
  reload — the entry survives; load it; delete it — the list is empty.
- Mac: the page in the native app (import via file input in
  WKWebView, export dialog), and an existing autosave plus old slots
  survive the upgrade.
