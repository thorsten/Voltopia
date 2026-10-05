# Project: Voltopia – a modern, simplified city builder for the browser

## Goal

Build a city-building game as a web app, inspired by the classics of the genre
but deliberately its own thing: streamlined, approachable, with a modern
low-poly 3D look (in the spirit of Townscaper / Islanders / Mini Motorways).
The city runs exclusively on renewable energy, and all vehicles are electric.
Balancing fluctuating generation against consumption is a core game mechanic.
Do not use trademarks, assets, or code from existing games.

## Design Principles

- Few, clear key metrics: money, population, happiness, energy balance
- Feedback directly in the world (icons above buildings, toggleable color
  overlays, lighting) instead of statistics dashboards
- Organic growth: buildings appear and densify visibly over time
- Minimal micromanagement, quick to understand, satisfying building interactions
- The energy transition as a playful challenge, not a lecture

## Tech Stack

- React, Vite, TypeScript (strict), pnpm
- three.js with an orthographic camera (isometric perspective, rotatable in
  90° steps, zoomable, pannable)
- Simulation in a Web Worker, rendering on the main thread
- Vitest for unit tests of the simulation, code coverage over 90%
- Playwright for end-to-end tests of the UI
- Persistence via IndexedDB, app playable offline as a PWA, should be extensible
  to other storage backends
- use React v19 best practices

## Architecture

- Strict separation: `sim/` (pure logic, no DOM/three.js dependencies),
  `render/`, `ui/`, `shared/` (types, message protocol)
- Simulation state stored in typed arrays per layer (tile type, zone, density,
  supply, happiness …) on a grid (initially 64×64, configurable)
- Fixed simulation tick (e.g. 4/s) with speed settings (pause, 1×, 3×)
- Deterministic: seeded RNG (including weather) so save games and tests are
  reproducible
- Worker ↔ main thread communication via typed messages; the worker sends only
  diffs of changed tiles plus global values (time of day, weather, energy
  balance), never the full state
- Rendering with InstancedMesh (buildings, vehicles) so large cities stay smooth

## MVP Scope

1. Terrain: flat grid with a subtle grid overlay while building
2. Roads: drawn by dragging, automatic intersections/curves/dead ends
3. Zones: residential, commercial (jobs), and retail painted by dragging (only
   grow next to roads)
4. Growth: demand model (residential needs jobs, jobs need residents, retail
   needs both); buildings grow through 3 density levels, procedurally generated
   from low-poly shapes with slight variation
5. Energy: renewable generation, storage, and energy balance (see section
   "Energy & Mobility")
6. E-mobility: visible electric vehicles, charging load, charging hubs (see
   section "Energy & Mobility")
7. Economy: starting funds, construction costs, tax income per tick, upkeep
   (including plant operating costs), a tax slider
8. Tools: bulldozer, undo for the last action
9. Overlays: supply and demand as toggleable color maps
10. HUD: money, population, happiness, demand bars (R/C/R), time/weather,
    energy panel, game speed
11. Save/load via IndexedDB, autosave

## Energy & Mobility

The city is powered exclusively by renewable energy. There are no fossil-fuel
power plants. The challenge is keeping fluctuating generation and consumption
in balance.

### Day/Night & Weather

- Day-night cycle (one in-game day ≈ a few minutes real time) with visible
  lighting: sun position, dusk, lit windows and streets at night
- Simple weather system: cloud cover (affects PV) and wind speed (affects wind
  power), varying smoothly, shown in the HUD

### Seasons

- A year of 20 in-game days, four seasons of five days; the season is a
  deterministic function of the day (added after the MVP; see the
  seasons spec)
- Temperature, day length, sun strength and weather-front biases follow
  the year; sub-zero precipitation builds a snowpack that melts into the
  river in spring
- Every building heats and cools electrically: a heating load that grows
  with the cold and a cooling load that grows with summer heat, both
  halved by a one-off building insulation upgrade

### Generation & Storage

- Solar farm (ground-mounted PV): output depends on sun position and cloud cover
- Wind turbine: output depends on wind speed, visibly spinning rotors (speed
  proportional to output)
- Battery storage: charges on surplus, discharges on deficit, state of charge
  (SoC) visible on the building
- Biogas plant: expensive to run but dispatchable – a backup for periods of
  low wind and no sun ("Dunkelflaute")
- Optional later: rooftop PV that grows automatically with increasing density

### Grid & Balance

- Connection via power lines: a bitmask layer over roads and water, a small
  connection radius around energised tiles and plants, one global balance
  (added after the MVP; see the power-lines spec)
- Global energy balance per tick: generation vs. consumption
- Surplus: charge storage first, then curtail (curtailed energy is displayed)
- Deficit: discharge storage, then biogas, then undersupply – affected buildings
  flicker/go dark, happiness drops, growth stops
- Load profile per zone: residential in the morning/evening, commercial during
  the day, retail from daytime into the evening

### E-Mobility

- All vehicles are electric
- Vehicles commute: each car drives home → workplace in the morning and
  back in the evening along the cheapest route (Dijkstra over road tiles,
  weighted by road class and traffic load). A lane holds two cars; queues
  form behind full tiles, long commutes lower happiness, and a per-tile
  traffic load feeds a traffic overlay. Avenues (drawn over streets) carry
  four cars per lane at higher speed (added after the MVP; see the traffic
  spec)
- Charging creates consumption: a pronounced evening charging peak in
  residential areas
- Buildable charging hubs at workplaces shift charging load into the daytime
  (matching PV generation)
- "Smart Charging" upgrade: charging load automatically follows generation
  surplus
- Delivery traffic: a logistics depot sends electric vans on tours to the
  retail buildings; a shop without a delivery for 1.5 days stops
  densifying. Vans share lanes and traffic load with commuters and charge
  at the depot (added after the MVP; see the deliveries spec)
- Public transit: bus stops marked on road tiles and a bus depot whose
  electric buses tour the stops that waited longest; a commuter with a
  served stop near home and near work leaves the car at home (added
  after the MVP; see the transit spec)

### HUD & Overlays

- Energy panel: current generation per source, consumption, storage SoC,
  surplus/deficit, mini history graph of the last 24 in-game hours
- "Supply" overlay: supplied / undersupplied / not connected
- Use technically correct energy terminology in code and UI (e.g. generation,
  consumption, state of charge, curtailment, peak load)

### Services

- Fire and police stations cover a ring of tiles while connected to the
  grid. Fire cover unlocks the top building density; police cover keeps
  happiness and tax income up once the city has 100 residents. A
  services overlay shows coverage (added after the MVP; see the services
  spec).

## Visual Style

- Reduced, harmonious color palette, soft shadows, gentle lighting
- Day-night lighting as a key stylistic element: warm window lights, streetlamps,
  vehicle headlights
- Short animations when building and growing (fade-in/scale)
- Clean, modern UI with highly readable typography

## Out of Scope for the MVP

Real pathfinding/traffic simulation, water, disasters,
terrain elevation, sound, multiplayer, electricity market/import/
export. Design the architecture so that additional layers, building types,
and energy sources can easily be added later.

(Most of these shipped after the MVP: pathfinding, water + hydro,
terrain elevation, sound, the import/export market, and more.)

## Future Ideas (post-MVP backlog)

Collected 2026-09-24; roughly in the order we want to build them.

- **Hydrogen & electrolysers** (done): a hydrogen plant that
  electrolyses the surplus batteries and pumped storage cannot take —
  ahead of the export link, since a stored unit later replaces an
  expensive import — stores H2, re-electrifies it in a Dunkelflaute, and
  once the tank is full sells hydrogen whenever that beats exporting:
  curtailment gets a value.
- **Dynamic electricity market** (done): the existing import/export
  market gets a moving spot price driven by weather/time of the
  neighbouring region, a price chart, and storage arbitrage (charge
  cheap, sell dear).
- **Forests & nature** (done): woodland tiles (generated + plantable in
  3 growth stages) raise happiness in reach, cost a felling fee when
  built through, and slow the wind for turbines standing in them.
- **Sea edge & tidal power** (done): one seed-chosen map edge becomes
  sea, widening into a bay at the river mouth. A two-constituent tide
  clock (lunar + solar) produces two high waters and four generation
  peaks a day, with spring and neap tides beating over ~7.4 days —
  fully predictable, unlike wind and solar. Tidal plants sit on coastal
  sea tiles; their output scales with a site factor that rewards narrow
  water and river mouths. The same coast carries offshore wind turbines
  (free, unsheltered wind) and raises the happiness of buildings with a
  sea view.
- **Railways**: trains connecting villages/districts on large maps;
  best built after per-district grids so regions mean something.
- **Smart-meter rollout** (done): the free smart-charging toggle becomes
  a paced programme — crews install 15 meters an in-game day at 60 money
  each, so a mid-size city takes about an in-game year to cover and new
  buildings keep costing. Coverage gates smart vehicle charging and
  feeds a flexible load pool (15 % of metered household load, 30 % of
  metered electric heating) that waits for renewable surplus, carries a backlog of at
  most four hours before comfort wins, and shows up as a dashed
  unshifted line in the energy graph, shifted-load rows in the energy
  panel and the `flexibleCity` goal.
- **Disasters/events** (done): storms (warned hours ahead) feather the
  wind fleet past cut-out speed and strike pylons, turbines, plants and
  buildings; fires (no warning, finally giving fire stations an active
  role) ignite from drought and uncovered density — or in a mature wood
  itself — and spread through neighbours and woods, checked by roads,
  water and coverage; river floods (also warned ahead) fill the same low
  ground from the river and the lake every time, a band along the bank
  that the water climbs until it runs out of head. Damage is never
  destruction — a tile goes out of service and heals against its own
  budget line, freezing when the treasury is empty — and the intensity is
  chosen when a city is founded, so existing saves keep playing without
  any of it.
- **Heat sector** (done): seasons already made heating a winter load;
  district heating turns it into a choice. A heat plant is a large heat
  pump feeding the roads touching it; every building beside those roads
  takes its heat from the network at the pump's COP, which falls with
  the cold. A heat store is a hot-water tank the surplus cascade fills
  through the pumps — after batteries and pumped storage, before
  export, and only while the nights are cold — and drains for the
  evening peak. Heat never turns back into electricity, and whatever the
  network cannot cover is heated on site as before.
- **Geothermal plants** (done): seed-generated hotspot fields in the
  highlands carry the game's only true baseload — constant through
  night, storm and Dunkelflaute. Each field has a quality, a sustainable
  well count and a shared heat reservoir that cools toward a lower
  equilibrium when it is overdrilled and recovers once the excess wells
  go, so a field drilled out yields clearly less than its well count
  suggests.
- **Demand response** (done): a contract with the commercial and
  retail zones under which a share of their base load is shed
  automatically in a deficit — after storage and biogas, before
  import — whenever a call is cheaper than importing at the spot price
  or the link alone cannot carry the shortfall, for a few hours a
  day. Paid as a daily retainer per business plus an activation
  premium per unit shed; the `loadManager` goal rewards a city that
  has shed its share. A 20-day probe found that a pool a tenth of the
  city's load (business base load on the office-hours profile, small
  in the dark, calm nights where deficits sit) structurally cannot
  halve blackout ticks; it shaves 8-10 % of deficit ticks and 9-10 % of
  import cost. The industrial zone (below) is that bigger pool. (A
  grid-frequency minigame stays an idea.)
- **Industrial zone** (done): factories grow with the retail jobs they
  stock, employ fewer people per tile than offices, run a two-shift
  load that is the grid's only real night-time draw and shed a larger
  share of it under the demand-response contract. Delivery vans load
  at a powered factory in reach before their shop leg; a depot without
  one imports the goods and pays a fee per tour. Homes within a few
  tiles of a factory are less happy, so placement is a decision. The
  `localGoods` goal rewards a day in which every tour loaded locally.
  Probe: with 40 factories in it the contract saves 32-49 % of the
  deficit ticks (452 -> 306, 250 -> 127) where the business pool alone
  saves 27-33 %, though the band's own load still leaves more deficit
  ticks than a town without it; and the factories spare 6_500 of goods
  fees over 20 days while their night shift costs 3.3 times their tax
  in a park not sized for them.
- **Per-district grids** (deferred earlier): separate grid islands
  with their own balance, coupled by substations.

## Way of Working

- Start with a short architecture and implementation plan and wait for my
  approval
- Then work in small milestones, each runnable at the end:
  M1 Project setup + grid + camera
  M2 Road building
  M3 Zones + worker simulation + growth
  M4 Day/night + weather + lighting
  M5 Generation, storage, energy balance + economy + HUD
  M6 Electric vehicles + charging load + charging hubs
  M7 Overlays + save/load + PWA
- Cover the simulation with unit tests (demand, growth, grid connectivity,
  energy balance, storage logic, money)
- Code and comments in English, descriptive names, no magic numbers (balancing
  values centralized in a config file)
- After each milestone: a short summary of what's done and what comes next
