# Save Slots Implementation Plan

> **For agentic workers:** execute task by task, in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A free list of named saves on their own page (load, overwrite, rename, delete, export per entry, import as a new entry), a guard so the autosave never overwrites a just-loaded city, and agent tools with the same reach.

**Architecture:** `src/storage/` gets a pure catalogue layer (`catalog.ts`) over a two-store key/value interface, implemented by IndexedDB (DB version 2, stores `saves` + `summaries`) and by an in-memory store for tests. The UI gets `SavesPage.tsx`; the settings page loses its save sections. `App.tsx` routes every "replace the city and reload" through one helper with a `leaving` guard. Agent tools get a `saves` member on `AgentContext`.

**Tech Stack:** TypeScript, vitest, React 19, Playwright. Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm e2e`.

**Spec:** `docs/superpowers/specs/2026-10-15-save-slots-design.md` — read it first; it is the source of truth for behaviour.

## Global Constraints

- No new dependencies (in particular no `fake-indexeddb`).
- Every user-visible string goes through `src/ui/i18n.tsx`, English AND German.
- `SaveGame` format unchanged, no `SAVE_VERSION` bump.
- `src/agent/tools.ts` stays DOM-free; only `webmcp.ts`/`useAgentTools.ts` touch the browser.
- React effects depend on stable identities (`bridge.send`, `bridge.onSaveData`), never on `bridge`.
- Run `pnpm format` after edits; the pre-commit hook runs typecheck, lint, format:check and tests. Never `--no-verify`.
- Commit messages: imperative summary + short body, one change per commit, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Overwrite without a name keeps the old name; the autosave never appears in `list()` — Task 1.
2. The v1 → v2 upgrade keeps the autosave and turns `slot1`..`slot3` into "Slot N" entries — Task 1.
3. Save + summary are written/deleted in one IndexedDB transaction — Task 1.
4. After "Load", no autosave write can land before the reload (interval, visibility, native close) — Task 2.
5. Import adds an entry and does NOT load it; invalid files show the error — Task 3.
6. `load_save` rejects incompatible saves; unknown ids are `ToolInputError`s — Task 4.

---

### Task 1: Storage catalogue, summaries, migration

**Files:**

- Create: `src/storage/summary.ts`, `src/storage/summary.test.ts`
- Create: `src/storage/catalog.ts`, `src/storage/catalog.test.ts`
- Create: `src/storage/memory.ts` (in-memory `SaveStorage` for tests; not imported by app code)
- Modify: `src/storage/storage.ts`, `src/storage/indexeddb.ts`

**Interfaces (produce exactly these):**

- `storage.ts`: `SaveSummary` and the extended `SaveStorage` as in the spec (`load`, `save(game, slot?, name?)`, `clear`, `list`, `rename`); `AUTOSAVE_SLOT` stays; add `LEGACY_SLOT_IDS = ['slot1','slot2','slot3'] as const` and `newSlotId(now = Date.now(), random = Math.random): string`.
- `summary.ts`: `summarizeSave(save: SaveGame, name: string, savedAt: number, population?: number): SaveSummary` (population override = live stats; default last `lifetime` sample or 0).
- `catalog.ts`:
  - `interface CatalogStores { getSave(id): Promise<SaveGame|undefined>; getSummary(id): Promise<SaveSummary|undefined>; allSummaries(): Promise<SaveSummary[]>; write(id, save, summary|null): Promise<void> /* one transaction; null summary = autosave, no summary row */; remove(id): Promise<void> /* both rows */; }`
  - `class SaveCatalog implements SaveStorage` built on `CatalogStores` (+ injectable `now()`): load returns null on version mismatch; save on a non-autosave slot writes a summary (name: given ?? existing ?? `id`); rename rejects unknown ids and empty/whitespace names (`Error`); list sorts by `savedAt` desc and recomputes `compatible`.
  - `migrateLegacySlots(stores: CatalogStores, now: number): Promise<void>` — for each legacy id with a save and no summary, writes summary "Slot N".
- `memory.ts`: `MemoryCatalogStores` (Maps) and `createMemoryStorage(now?)` returning a `SaveCatalog`.
- `indexeddb.ts`: `DB_VERSION = 2`; `onupgradeneeded` creates `summaries` and, when `oldVersion < 2`, runs the migration inside the upgrade transaction (write a small synchronous-cursor variant or reuse the summarize logic directly — the upgrade transaction cannot await foreign promises; keep it correct, comment why). `IndexedDbStorage` becomes `new SaveCatalog(new IndexedDbStores())`-backed with the same exported class name. Errors in `load` are still swallowed with a warning.

- [ ] Write tests first (summary, catalogue behaviours from Review Focus 1, migration over memory stores, `newSlotId` format), see them fail, implement, see them pass.
- [ ] `pnpm typecheck && pnpm test`, `pnpm format`, commit "feat(storage): named save catalogue with summaries".

### Task 2: One path to replace the city and reload

**Files:** Modify `src/ui/App.tsx`, `src/ui/nativeClose.ts` (only if the persist hook needs the guard there), tests where logic is extractable.

- Add a module-level `leaving` flag and `replaceCityAndReload(save: SaveGame | null): Promise<void>` (sets flag, then `storage.save(save)` or `storage.clear()`, then `window.location.reload()`).
- The `onSaveData` autosave handler and the native-close `persist` skip writing while `leaving` is set (native close: resolve without writing so the window still closes).
- Route `startNewGame`, `startNewCityFromTool`, and (Task 3) the saves page load through it. Put the guard logic in a small testable module if it helps (e.g. `src/ui/cityReload.ts` with an injected storage + reload), with a unit test that a save arriving after the flag is set is dropped.
- [ ] Implement, test, commit "fix(ui): no autosave can overwrite a city being replaced".

### Task 3: Saves page

**Files:**

- Create: `src/ui/SavesPage.tsx`, `src/ui/saveFiles.ts`, `src/ui/saveFiles.test.ts`
- Modify: `src/ui/App.tsx` (footer button `open-saves` between Imprint and Settings, page `'saves'`), `src/ui/SettingsPage.tsx` (remove save slots + backup sections and the `storage`/`requestSnapshot` props), `src/ui/i18n.tsx` (en + de `saves.*`, `footer.saves`, drop unused `settings.*` save keys, one `help.*` line), CSS where the existing `.settings-slot` styles live (reuse/rename sensibly).
- `saveFiles.ts`: `slugify(name)`, `saveFileName(name, date)` → `voltopia-<slug>-<YYYY-MM-DD>.json` (slug falls back to `save`), `nameFromFileName(fileName)`.
- Page behaviour, test ids and texts: exactly as in the spec section "Saves page". Live population from `stats.population` for "Save as new" and Overwrite. Two-step confirm resets after 4 s (constant in the component, named). Load goes through `replaceCityAndReload`.
- [ ] Unit-test `saveFiles.ts`; `pnpm typecheck && pnpm test`; commit "feat(ui): saves page with named saves".

### Task 4: Agent tools

**Files:** Modify `src/agent/tools.ts`, `src/agent/tools.test.ts` (or a new `src/agent/tools.saves.test.ts`), `src/ui/useAgentTools.ts`, `src/ui/App.tsx` (pass the saves context), `docs/agent-tools.md`.

- `AgentContext.saves` as in the spec; tools `list_saves` (readOnlyHint), `save_to_slot`, `load_save` (consequentialHint), `delete_save` (consequentialHint). Default name like the UI's (share one helper, DOM-free, e.g. in `src/storage/summary.ts`: `defaultSaveName(day, cityLabel)`; the UI passes the translated label, the tool uses English).
- Tests against `createMemoryStorage()` + the headless engine context already used in `tools.test.ts`.
- `docs/agent-tools.md`: four rows next to `save_game`; keep the table formatting (`pnpm format` handles markdown).
- [ ] Commit "feat(agent): save slot tools".

### Task 5: End-to-end test

**Files:** Modify `e2e/game.spec.ts`.

- Test "saves page keeps named saves": open saves, save as "Testville", rename to "Testville 2", reload, entry still there, load it (page reloads, money visible), delete with confirm, list empty.
- [ ] Run `pnpm e2e` if Chromium works in the sandbox (else note it for the Mac); commit "test(e2e): saves page".
