# Voltopia — project guide

Browser city builder powered entirely by renewables. Design doc:
`docs/idea.md`, implementation plan: `docs/plan.md`.

## Commands

```bash
pnpm dev          # dev server
pnpm test         # unit tests (vitest) — MUST pass before every commit
pnpm coverage     # tests + coverage gate (>=90% on src/sim + src/shared)
pnpm e2e          # Playwright end-to-end tests
pnpm typecheck    # tsc -b
pnpm lint         # oxlint
pnpm format       # oxfmt (writes); format:check verifies
pnpm audit:prod   # fails on high/critical advisories in prod deps only
pnpm build        # production build (includes typecheck)
pnpm tauri dev    # native macOS window (Mac only)
pnpm tauri build  # .app + .dmg (Mac only)
pnpm tauri ios dev 'iPad Pro 13-inch (M4)'  # iPad simulator (Mac only)
```

A pre-commit hook (simple-git-hooks, installed via `pnpm install`) runs
`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
automatically. Never commit with failing checks; never bypass the hook
with `--no-verify` unless the user asks. Run `pnpm format` after edits —
formatting is enforced (oxfmt, single quotes, config in `.oxfmtrc.json`).

## Architecture (strict boundaries)

- `src/sim/` — pure simulation, runs in a Web Worker. **No DOM or
  three.js imports.** Deterministic: all randomness through the seeded
  `Rng` on `SimState` (including weather). Fixed tick (4/s).
- `src/render/` — three.js only (instanced meshes, isometric camera).
  Reacts to tile diffs (`DiffLayer`) and stats-driven environment.
  New `InstancedMesh`? Always set `frustumCulled = false` — instance
  transforms span the grid and the base-geometry bounds would cull them.
- `src/ui/` — React 19. All user-visible strings go through
  `src/ui/i18n.tsx` (English + German — add BOTH when adding keys).
- `src/shared/` — types, worker message protocol, and `constants.ts`
  with the central `BALANCE` config. **No magic numbers in sim code**;
  every tuning value lives in `BALANCE`.
- `src/storage/` — save games behind the `SaveStorage` interface.
- `src/agent/` — WebMCP / `window.voltopia` tools for agents
  (`docs/agent-tools.md`). `tools.ts` is DOM-free and tested against a
  headless `SimEngine`; only `webmcp.ts` touches `document`/`window`.
  New sim command? Add a tool if an agent would need it. New plant,
  zone, or sim feature? Update `tools.ts`, the tool descriptions, and
  `docs/agent-tools.md` table to keep feature parity.
- `src-tauri/` — Tauri v2 shell (Rust). Loads the unchanged `dist/`.
  Native-only frontend behaviour goes through `src/ui/platform.ts`
  (`isNativeApp()`, `exportTextFile`) and `src/ui/nativeClose.ts`; Tauri
  JS modules are imported dynamically so the web bundle and node tests
  never load them. CSP and capabilities live in `src-tauri/tauri.conf.json`
  and `src-tauri/capabilities/default.json` — widen them deliberately.

Worker ↔ main: commands in, tile diffs + `GlobalStats` out — never the
full state (except save snapshots).

## Conventions

- Tests colocated as `*.test.ts`; sim changes need unit tests. For
  balancing changes, write a temporary headless probe (script a city via
  `SimEngine`, run N in-game days, print pacing) — see the commit
  "balance: resize energy system" for the pattern — and delete it after.
- React effects must depend on stable identities (`bridge.send`,
  `bridge.onSaveData`), never on the `bridge` object — it changes every
  tick and silently resets intervals/drag state (caused a real bug).
- Save-game changes: keep `SaveGame` backward compatible (optional
  fields) or bump `SAVE_VERSION` knowingly (old autosaves are dropped).
- Use correct energy terminology (generation, consumption, state of
  charge, curtailment, peak load) in code and UI.
- Commit messages: imperative summary + short body; one feature/fix per
  commit.

## Environment gotchas

- `pnpm-workspace.yaml` pins `supportedArchitectures` (darwin+linux,
  arm64+x64) because `node_modules` is shared between the macOS host and
  a Linux dev sandbox — do not remove.
- The Linux sandbox has no WebGL: the app falls back gracefully; visual
  checks and the WebGL e2e test need the Mac (or CI, which has
  SwiftShader). Headless smoke: `node scripts/smoke.mjs`.
- e2e uses `127.0.0.1` (not `localhost`) and Chromium flags
  `--no-proxy-server --no-sandbox` (see `playwright.config.ts`).
- CI runners are 2-4x slower than dev machines — long sim tests need
  generous vitest timeouts (`testTimeout` is 60s). Vitest workers also
  have a fixed 60s RPC timeout that synchronous tests can trip ("Timeout
  calling onTaskUpdate" with every test green): `src/test/yieldBetweenTests.ts`
  yields the event loop after each test, so only the longest single test
  matters — keep any one sim test under ~15s locally under `pnpm coverage`
  and split heavy suites into several files. New per-tick sim work is a
  CI budget too: gate it when its feature is absent.
- When adding a dependency that has build/postinstall scripts, pnpm 12
  hard-fails a fresh install (`ERR_PNPM_IGNORED_BUILDS`) until the
  package is approved. The approval lives in `pnpm-workspace.yaml`
  (`allowBuilds`), so run `pnpm approve-builds <pkg>` and commit the
  changed `pnpm-workspace.yaml` IN THE SAME COMMIT as the dependency —
  otherwise CI's install step breaks on that commit (this happened with
  `simple-git-hooks`).
- The Linux sandbox cannot build the native app (no cargo, no Xcode);
  `pnpm tauri …` runs on the Mac. `src-tauri/gen/apple` is generated by
  `tauri ios init` and committed — edit `project.yml`, never the
  `.xcodeproj`. The PWA plugin is skipped when `TAURI_ENV_PLATFORM` is set.
  The Rust shell holds the window open on close until the frontend has
  autosaved and calls `close_app` (2 s JS timeout, 3 s Rust fallback).

## Deployment

Push to `main` → GitHub Actions runs typecheck/tests/build and deploys
to GitHub Pages (base path `/Voltopia/` via `VOLTOPIA_BASE`). PRs and
branches run `.github/workflows/ci.yml` in three jobs: `quality`
(format, lint, prod-dependency audit), `test` (typecheck, coverage,
build) and `e2e`. The audit gate is CI-only — it is not in the
pre-commit hook, because it needs the registry.
