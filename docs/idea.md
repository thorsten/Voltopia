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
- Fixed simulation tick (e.g. 4/s) with speed settings (pause, 1×, 3×, 6×)
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
- **Railways** (done): trains connecting villages/districts on large
  maps; best built after per-district grids so regions mean something.
  Tracks are their own line layer (level crossings whose barriers close for an approaching train and hold road traffic back, bridges); a rail
  yard fields passenger trains for the stations with the longest wait
  and a freight train from factory terminals to depot terminals, and
  feeds their catenary from its own grid island, so a deficit there
  stalls them. A commuter with a served station near home and another
  near work leaves the car at home; a depot supplied by rail stops
  importing. A two-district probe over an in-game year: two stations
  per district carry 92-94 % of the cross-town commute, the evening
  charging peak halves (132 -> 59) and the line earns its upkeep from
  the import it saves on a well-stored island (traction 1_400 a year
  against 7_700-9_300 saved), while the same yard on a biogas island
  pays 17 times the traction bill and stalls its trains at dusk.
- **Smart-meter rollout** (done): the free smart-charging toggle becomes
  a paced programme — crews install 15 meters an in-game day at 60 money
  each, so a mid-size city takes about an in-game year to cover and new
  buildings keep costing. Coverage gates smart vehicle charging and
  feeds a flexible load pool (15 % of metered household load, 30 % of
  metered electric heating) that waits for renewable surplus, carries a backlog of
  four hours before comfort wins — at night stretched to an hour past
  sunrise, at most ten, so an evening's deferral reaches the morning
  sun — and shows up as a dashed
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
  ticks than a town without it. A second probe gave industrial jobs
  a trade tax rate (twice the job rate) and took the load one notch
  down, so a factory earns like a shop per unit of energy; a band with
  40 batteries bought for it now breaks even in its first year on a
  well-stored city and stays a loss on one that burns biogas every
  night — the park decides.
- **Per-district grids** (done): lines and plants partition the map
  into grid islands, each balancing its own generation, storage and
  curtailment instead of sharing one city-wide pool. A substation is
  the only gate between an island and the outer grid, so an island
  without one stands entirely on its own. The Grid overlay colours
  each island and dims the ones with no substation, the energy
  drawer lists every island's own figures, the inspector names a
  tile's district, and the `districtGrid` goal rewards a city where
  every sizeable island has a substation and no island saw a deficit
  all day. A two-island probe over an in-game year says splitting a
  town costs it almost nothing in money (1.2 % under the old
  single-balance city) but moves the shortage where it belongs: the
  home island can no longer borrow the business island's midday
  surplus, so a substation pays for itself in six weeks on the island
  with a surplus to sell and is a bill worth paying on the one that
  goes short.
- **Scenarios** (done): four fixed maps with a stamped starting town,
  rules (import link, start season, disaster intensity), starting
  funds, a deadline in days and win/fail conditions evaluated once a
  day — "island without an import link", "survive a winter
  Dunkelflaute", "electrify an old town" and "storm season with a
  fragile wind fleet". A scenarios page starts them, an objectives
  panel tracks the conditions and an end screen reports the result;
  agents can list and start them too. A headless probe (each scenario
  once ignored, once with a scripted plan that reinvests its income in
  plants) set the targets in `BALANCE.scenarios`:
  - Island (20 days): ignored → failed on day 20 (34 residents, 15_341
    deficit ticks); planned (9 wind, 2 solar, 17 batteries, two blocks
    zoned) → won with 448 residents (target 360) and 554 deficit ticks
    in the closing winter (limit 800).
  - Dunkelflaute (90 days): ignored → failed on day 90 (360 residents,
    51_774 deficit ticks); planned (23 wind, 41 batteries) → won with
    643 residents (target 510) and 3_614 deficit ticks (limit 5_400).
  - Old town (180 days): ignored → failed on day 180 (0.00 supplied);
    planned (lines along the roads, 16 solar, 35 wind, 64 batteries) →
    won at 1.00 supplied and 1.00 renewable (targets 0.95 and 0.8).
  - Storm season (120 days): ignored → failed on day 8 (0.44 supplied,
    under the 0.5 floor); planned (second line, fire station, 10 solar,
    6 wind, 13 batteries near the town) → won with stormProof and 189
    deficit ticks in the last 30 days (limit 300), worst day 0.59
    supplied.

### Next ideas (collected 2026-10-11)

Everything above has shipped. These are the candidates for what comes
next, roughly in the order we would build them.

- **Save slots** (done): named slots with load, delete and
  export/import in the web build as well as the native app (settings
  page).
- **Grid-frequency minigame**: inertia and reserve power as a
  mechanic — a sudden plant outage or storm cut-out drops the
  frequency, batteries and demand response hold it, too little reserve
  cascades into a blackout. Already noted under demand response, never
  built.
- **Policies / ordinances** (done): four switches in the console, each
  with a daily administration cost (budget line "policies"), a
  happiness term and one sim effect — rooftop-PV mandate (new
  buildings get panels, subsidy per building), night tariff (plain
  cars charge at home only at night, bigger household flex share),
  speed limit (slower commuter cars, less battery drain) and
  smart-meter mandate (twice the install rate, households pay half,
  unpopular until coverage is full). Agents switch them with
  `set_policy`. The combustion-car ban was dropped: the fleet is
  already electric. Probe (dunkelflaute town with a substation, 20
  days measured per ordinance): night tariff cut evening (18:00-22:00)
  charging 60 → 41 per tick without smart meters; the speed limit cut
  charging energy 6-11 % and raised congestion 1.02 → 1.07; the
  mandate reached full meter coverage ~3 days sooner (75 → 111 of 111
  after 5 days); the PV mandate put panels on 5-11 new buildings, too
  few to show above the weather noise. `BALANCE.policies`: night
  tariff 30 → 60 and speed limit 10 → 50 a day (10-14 % of their
  import savings), speed limit and smart-meter mandate happiness
  -0.03 → -0.02 so any two ordinances keep the town above the growth
  minimum (worst pair 0.37).
- **Finance** (done): loans (5_000-20_000, 10 days, amortising,
  repayable early) and bonds (50_000/100_000, 40 days, interest only)
  at fixed yearly rates, overdraft interest on a negative treasury and a
  credit rating A-D from debt in days of income and days ending in the
  red (spread on new credit, D refuses it); a renewable investment grant
  (30 % on renewables, 20 % on storage) from a yearly pot; a grid-fee
  slider beside the tax, smart-metered buildings pay half. Scenario
  money goals measure net worth, so a loan cannot win them; bankruptcy
  is judged on cash, so a loan spent on plants cannot lose them. Agents use
  `take_credit`, `repay_credit` and `set_grid_fee`. Probe (dunkelflaute
  town with a substation and a starter wind fleet, 20 days, 8 weather
  seeds): a 50_000 bond spent on 10 plants ended the year 500 ahead of
  the same plants bought from cash in the import-heavy town and 500
  behind in the supplied one (cash catches up within days there);
  20_000 + 10_000 in loans ended 1_800 ahead; a 20_000 loan burnt on
  nothing ended 21_500 behind the baseline; overbuilding (100_000 on
  25 plants) lost 55_000 against cash. A fee raising the same money as a
  tax increase cost 0.88 times its happiness unmetered (fee 0.002: 773
  a day, -0.020 against -0.023), so `happinessWeight` 10 stays. The
  debt cap now averages income over the full window (unplayed days
  count 0): a new city gets 30_000 of loans, the supplied town's 50_000
  bond came on offer after 2-3 days, a town importing at a loss never
  gets one. The grant pot went 15_000 -> 4_000 (about three solar
  farms' price): 15_000 never ran dry for a small city; with 4_000 a
  cash build bought 14 plants in a year against 11 without a pot and 18
  with 15_000.
- **Neighbouring cities**: the market is abstract. Concrete neighbours
  with their own generation mix, supply contracts and interconnectors
  whose capacity the player buys.
- **Cycling and walking** (done): bike lanes and pedestrian streets
  (a road lane kind) replace short car trips. A commuter walks when
  home and work are at most 4 tiles apart and cycles up to 20 tiles
  when bike lanes or pedestrian streets cover the tiles between home
  and work (the end tiles need none);
  riders leave the car parked, so they draw no charging load. Probe
  (48x48 grid, seed 3, bike lanes on every road, 12 days with the
  last 6 measured): active share 0.32 with lanes versus 0.004
  without, evening (18:00-22:00) charging load 107 versus 167 per
  tick (-36%). The `BALANCE.cycling` values stayed unchanged.
- **Annual report / statistics replay**: multi-year time series,
  comparison of two saves, CSV export.
- **Difficulty and sandbox modes** (done): easy, normal and hard set
  the starting money. A sandbox toggle in the new-game dialog founds a
  city whose treasury is pinned at an unlimited amount (shown as ∞)
  with disasters off by default; costs and flows are still booked in
  the budget, but credit, the grant, the rating and the goals are off.
  The flag survives saves, and `start_new_city` takes `sandbox`. A 6x
  speed joins pause, 1x and 3x for every city.
- **Share a city**: seed plus compressed save as a URL.
- **Onboarding for the later systems**: the tutorial covers the basics;
  smart meters, demand response, grid islands, hydrogen and the heat
  sector each deserve a short guided introduction.

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
