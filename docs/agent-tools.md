# Playing Voltopia with an agent

Voltopia exposes its game actions as **WebMCP tools** so an AI agent (or
any script) can play without pixel-hunting. The same tools are available
in every browser on `window.voltopia`.

## Connecting

**WebMCP (Chrome ≥ 146).** WebMCP is an origin trial, so stable Chrome
has it switched off by default and `document.modelContext` does not
exist. Enable it locally:

1. Open `chrome://flags/#enable-webmcp-testing`, set it to _Enabled_ and
   relaunch Chrome (a full relaunch, not just a new tab).
2. Load the game from `http://localhost:5173` or the HTTPS deployment
   (secure context required; `127.0.0.1` over plain HTTP does not count).
3. DevTools → _Application_ → _WebMCP_: _Available Tools_ lists the 21
   tools and lets you invoke them.

Sanity check in the console: `document.modelContext` must be an object
(undefined means the flag is off), and
`(await document.modelContext.getTools()).length` is 21.

The app registers its tools with `document.modelContext` on boot
(falling back to the deprecated `navigator.modelContext`). Any WebMCP
client — Gemini in Chrome, the DevTools panel, or
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
— lists them via `getTools()` and runs them via `executeTool()`. Results
are MCP-style `{ content: [{ type: 'text', text: '<JSON>' }] }`. Chrome
154's `executeTool(tool, input)` expects `input` as a JSON **string**
(`'{"from":{"x":1,"y":1}}'`), not an object.

**Claude Code via Chrome DevTools MCP (native discovery).** Google's
[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
exposes `list_webmcp_tools` and `execute_webmcp_tool` (Chrome ≥ 150).
Register it once:

```bash
claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --categoryExperimentalWebmcp=true --chromeArg=--enable-features=WebMCP,WebMCPTesting
```

Then, in a new Claude Code session: "open http://localhost:5173, list the
WebMCP tools and grow the city to 100 residents". It launches its own
Chrome profile (so its own save); to drive your existing Chrome start it
with `--remote-debugging-port=9222` and use `--browserUrl=http://127.0.0.1:9222`
instead of `--chromeArg`. `node scripts/webmcp-demo.mjs` runs this whole
pipeline unattended as a smoke test.

**Without WebMCP.** Every tool is on `window.voltopia`:

```js
const { tools, call } = window.voltopia;
tools.map((t) => t.name); // discovery
await call('get_game_overview'); // plain JSON result
await call('build_road', { from: { x: 10, y: 10 }, to: { x: 20, y: 10 } });
```

Playwright, Puppeteer or a DevTools MCP `evaluate_script` can drive the
game this way (see the e2e test "agent tools drive the game").

## Conventions

- Coordinates are `{ x, y }`, 0-based; `x` grows east, `y` grows south.
- Zones: `residential`, `commercial`, `retail`. Plants: `solar`, `wind`,
  `battery`, `biogas`, `charging_hub`, `park`, `run_of_river`,
  `pumped_storage`, `hydrogen`, `tidal`, `geothermal`, `logistics_depot`,
  `bus_depot`.
  `tidal` must stand on an empty **sea** tile touching land (a coastal
  tile); its output follows the tide and rises in narrow water and at
  the river mouth — see `get_build_catalog` for the exact figures.
  `find_tiles` with kind `coastal_sea` lists exactly those buildable
  sites, and every `get_map` layer marks sea tiles with `%`.
  `geothermal` must stand on an empty **land** tile carrying a
  geothermal hotspot; it generates the same output day and night, but
  each hotspot field only sustains so many wells before its reservoir
  starts cooling and drags every well on it down. `find_tiles` with kind
  `geothermal_hotspot` lists the buildable hotspot tiles, the `terrain`
  `get_map` layer marks a hotspot tile with `^`, and `inspect_tile` on a
  hotspot or a geothermal plant reports the field's `hotspot` object
  (`quality`, `heat`, `wells`, `capacity`) so an agent can see a field
  nearing (or past) its well capacity.
- Write tools resolve to `{ ok: true, ... }` or
  `{ ok: false, error: '<code>', message: '<English text>' }`. The codes
  are the simulation's own rejection codes (`notEnoughMoney`,
  `tileOccupied`, `needsRiverTile`, `needsLakeShore`, `needsSeaTile`,
  `needsCoast`, `needsHotspot`, `cannotBuildOnWater`, `needsLineSite`,
  `alreadyInsulated`, `nothingToUndo`, `needsRoadTile`) plus
  `invalidInput` and `unknownTool`.
- Bad input never throws; it comes back as `invalidInput`.

## Tools

| Tool                 | Kind  | Purpose                                                                                                                                                                                                                           |
| -------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_game_overview`  | read  | Funds, population, jobs, happiness, demand, clock, season, weather, tide (level, current factor, rising), energy summary, budget, deliveries, transit, goals, counts                                                              |
| `get_build_catalog`  | read  | Static rules: costs, upkeep, plant roles and placement, supply radius                                                                                                                                                             |
| `get_energy_report`  | read  | Full energy stats incl. the last day's history                                                                                                                                                                                    |
| `get_map`            | read  | ASCII map (whole grid or a window) — layers `overview`, `terrain` (`.` land, `~` river, `#` lake, `%` sea, `^` hotspot), `supply`, `density`, `power`, `transit`                                                                  |
| `inspect_tile`       | read  | Every field of one tile plus live figures and growth blockers (incl. delivery state and depot fleet, bus stop state and coverage, bus depot fleet, geothermal `hotspot` field)                                                    |
| `find_tiles`         | read  | Tiles by kind (`empty_land`, `river`, `lake_shore`, `coastal_sea`, `geothermal_hotspot`, `road`, `power_line`, `plant`, `zoned_empty`, `building`, `not_connected_building`, `undersupplied_building`, `bus_stop`), nearest-first |
| `get_lifetime_stats` | read  | One sample per in-game day                                                                                                                                                                                                        |
| `build_road`         | write | L-shaped path `from`→`to` (horizontal leg first) or explicit `tiles`                                                                                                                                                              |
| `build_power_line`   | write | Same shape as `build_road`                                                                                                                                                                                                        |
| `build_bus_stop`     | write | Same shape as `build_road`; marks stops on road tiles                                                                                                                                                                             |
| `paint_zone`         | write | Rectangle `from`→`to` with `zone`                                                                                                                                                                                                 |
| `place_plant`        | write | `plant` at `x`, `y`                                                                                                                                                                                                               |
| `bulldoze`           | write | Rectangle `from`→`to`                                                                                                                                                                                                             |
| `undo`               | write | Revert and refund the last build action                                                                                                                                                                                           |
| `set_speed`          | write | 0 (pause), 1, 3                                                                                                                                                                                                                   |
| `set_tax_rate`       | write | 0 … 0.3                                                                                                                                                                                                                           |
| `set_smart_charging` | write | `enabled: boolean`                                                                                                                                                                                                                |
| `set_market_trading` | write | `enabled: boolean` — storage sells at scarcity prices, buys cheap regional surplus                                                                                                                                                |
| `plant_forest`       | write | Rectangle `from`/`to` — plants saplings on empty land                                                                                                                                                                             |
| `buy_insulation`     | write | One-off heating upgrade                                                                                                                                                                                                           |
| `advance_time`       | write | Run `ticks` or `days` (max 3 days), then return a summary; fast-forwards a paused game and restores the speed                                                                                                                     |
| `save_game`          | write | Write the autosave now                                                                                                                                                                                                            |
| `start_new_city`     | write | New city (`size` 48/64/96, `difficulty`, `seed`); reloads the page                                                                                                                                                                |

A typical loop: `get_build_catalog` once, then repeat `get_game_overview`
→ `get_map` / `find_tiles` → build → `advance_time` → check
`inspect_tile` on anything that is not growing.

## How it works

- `src/agent/tools.ts` defines the tools over an `AgentContext` (stats,
  a main-thread tile mirror, promise-based commands). It has no DOM
  dependency and is unit-tested against a headless `SimEngine`.
- `src/agent/tileMirror.ts` rebuilds the tile layers from the diffs the
  worker already streams to the renderer.
- `src/agent/webmcp.ts` registers with `modelContext` and installs
  `window.voltopia`.
- Commands carry a `requestId`; the worker answers with a
  `commandResult` event so tools can await the outcome even while the
  game is paused.
