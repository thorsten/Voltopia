import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'en' | 'de';

const en = {
  'boot.loading': 'Voltopia is loading…',
  'webgl.fallback': '3D view unavailable (WebGL not supported here) — simulation keeps running.',

  'hud.funds': 'funds',
  'hud.residents': 'residents',
  'hud.jobs': 'jobs',
  'hud.happiness': 'happiness',
  'hud.traffic': 'traffic',
  'hud.traffic.title': '{label} · {driving} cars on the road · {avenues} % avenues',
  'hud.deliveries': 'deliveries',
  'hud.deliveries.title': '{supplied} of {shops} shops supplied · {vans} vans on the road',
  'hud.transit': 'transit',
  'hud.transit.title':
    '{riders} riders · {buses} buses on the road · {served} of {stops} stops served',
  'traffic.flowing': 'flowing',
  'traffic.slow': 'slow',
  'traffic.jammed': 'jammed',
  'hud.day': 'Day {n}',
  'hud.weather.title': 'Season and temperature · cloud cover / wind speed',
  'season.spring': 'Spring',
  'season.summer': 'Summer',
  'season.autumn': 'Autumn',
  'season.winter': 'Winter',
  'hud.season': '{season} {day}/{days} · {temperature} °C',
  'hud.tide': 'tide',
  'hud.tide.title': 'Tide: {state} · current {percent} %',
  'tide.rising': 'rising',
  'tide.falling': 'falling',
  'tide.high': 'high water',
  'tide.low': 'low water',
  'hud.demand.title': 'Demand: residential / commercial / retail',
  'hud.details': 'Details',
  'hud.section.city': 'City',

  'speed.pause': 'Pause',
  'speed.normal': 'Normal speed',
  'speed.fast': 'Fast (3x)',

  'tool.select': 'Select / pan',
  'tool.road': 'Road',
  'tool.avenue': 'Avenue',
  'tool.power-line': 'Power line',
  'tool.bus-stop': 'Bus stop',
  'tool.zone-residential': 'Residential',
  'tool.zone-commercial': 'Commercial',
  'tool.zone-retail': 'Retail',
  'tool.plant-solar': 'Solar farm',
  'tool.plant-wind': 'Wind turbine',
  'tool.plant-battery': 'Battery',
  'tool.plant-biogas': 'Biogas plant',
  'tool.plant-hub': 'Charging hub',
  'tool.plant-park': 'Park',
  'tool.plant-fire': 'Fire station',
  'tool.plant-police': 'Police station',
  'tool.plant-depot': 'Logistics depot',
  'tool.plant-busdepot': 'Bus depot',
  'tool.plant-hydro': 'Run-of-river plant',
  'tool.plant-pumped': 'Pumped storage',
  'tool.plant-hydrogen': 'Hydrogen plant',
  'tool.plant-tidal': 'Tidal plant',
  'tool.plant-geothermal': 'Geothermal plant',
  'tool.plant-forest': 'Plant woods',
  'inspector.forest': 'Woods',
  'inspector.forest.mature': 'mature · felling {fee} ⌁',
  'inspector.forest.growing': 'growing · felling {fee} ⌁',
  'hud.nature': 'nature',
  'hud.nature.title': '{share} % of the land is wooded',
  'tool.bulldoze': 'Bulldozer',
  'tool.undo': 'Undo',
  'tool.undo.title': 'Undo last build action',
  'tool.perTile': '{cost}/tile',

  // Build bar: category tabs and the tooltip body per tool.
  'build.category.basics': 'Basics',
  'build.category.zones': 'Zones',
  'build.category.energy': 'Energy',
  'build.category.services': 'Services',
  'tool.select.desc': 'Click a tile to inspect it, drag to pan the camera.',
  'tool.road.desc': 'Roads connect the city. Drag to build a line.',
  'tool.avenue.desc':
    'Twice the lane capacity and faster driving. Drag over a street to upgrade it.',
  'tool.power-line.desc':
    'Carries power from plants along roads. Buildings within three tiles of a connected line get supplied.',
  'tool.bus-stop.desc':
    'Mark a stop on a road. Commuters near a served stop at home and at work leave the car at home.',
  'tool.zone-residential.desc': 'Homes. Residents move in once the lot has a road and power.',
  'tool.zone-commercial.desc': 'Offices. Provide jobs for your residents.',
  'tool.zone-retail.desc': 'Shops. Keep residents happy and add jobs.',
  'tool.plant-solar.desc': 'Generates with sunlight — peaks at noon, nothing at night.',
  'tool.plant-wind.desc':
    'Generates with wind speed, day and night. Offshore turbines catch free wind for a bonus, at a construction surcharge.',
  'tool.plant-battery.desc': 'Stores surplus and releases it when generation drops.',
  'tool.plant-biogas.desc': 'Dispatchable generation, but burns fuel that costs money.',
  'tool.plant-hub.desc': 'Charges EVs in its service radius. Pairs with smart charging.',
  'tool.plant-park.desc': 'Raises happiness nearby. Generates nothing.',
  'tool.plant-fire.desc':
    'Buildings in its ring may reach the top density. Needs a road and power.',
  'tool.plant-police.desc': 'Keeps happiness and taxes up in its ring. Needs a road and power.',
  'tool.plant-depot.desc':
    'Sends electric vans to the shops. Shops without deliveries stop growing. Needs a road and power to charge.',
  'tool.plant-busdepot.desc':
    'Sends three electric buses on tours over your stops. Needs a road and power to charge.',
  'tool.plant-hydro.desc': 'Built on the river. Output follows the river flow.',
  'tool.plant-pumped.desc': 'Large storage on a lake shore. Pumps up on surplus.',
  'tool.plant-hydrogen.desc':
    'Electrolyses surplus the grid cannot take into hydrogen, re-electrifies it in a lull and sells the overflow once the tank is full.',
  'tool.plant-tidal.desc':
    'Built on the coast, generating from the tidal current: two high waters a day, four generation ' +
    'peaks and four slack-water gaps in between. Fully predictable, but drifts against the clock. ' +
    'Narrow water and the river mouth run faster.',
  'tool.plant-forest.desc':
    'Plant saplings by the patch. They grow over a few days, raise happiness nearby — and slow the wind for turbines standing in them.',
  'tool.bulldoze.desc': 'Clears roads, zones and plants. Drag to clear an area.',
  'tool.undo.desc': 'Undo the last build action.',

  'energy.title': 'Energy',
  'energy.solar': '☀️ Solar',
  'energy.wind': '🌀 Wind',
  'energy.hydro': '💧 Hydro (flow {flow}%)',
  'energy.tidal': '🌊 Tidal',
  'energy.biogas': '♻️ Biogas',
  'energy.standby': 'standby',
  'energy.rooftop': '🏠 Rooftop PV',
  'energy.consumption': '🏙 Consumption',
  'energy.charging': '🔌 EV charging',
  'energy.heating': '🔥 Heating',
  'energy.cooling': '❄️ Cooling',
  'energy.surplus': 'Surplus',
  'energy.deficit': 'Deficit',
  'energy.curtailed': 'Curtailed',
  'energy.import': '⤵️ Grid import',
  'energy.export': '⤴️ Grid export',
  'energy.storage': 'Storage (SoC)',
  'energy.pumpedStorage': 'Pumped storage (SoC)',
  'energy.fuelCell': 'Fuel cell',
  'energy.electrolysis': 'Electrolysis',
  'energy.hydrogenSold': 'Hydrogen sold',
  'energy.hydrogenStorage': 'Hydrogen tank',
  'energy.spot': 'Spot price',
  'energy.legend.price': 'Spot price',
  'energy.graph.label': 'Generation and consumption over the last day',
  'energy.legend.generation': 'generation',
  'energy.legend.consumption': 'consumption',

  'tax.label': 'Tax rate',
  'smartCharging.label': '⚡ Smart charging',
  'smartCharging.title': 'EV charging automatically follows the generation surplus',
  'marketTrading.label': '📈 Market trading',
  'marketTrading.title':
    'Storage works the spot market: sells its top charge at scarcity prices, buys cheap regional surplus',
  'insulation.label': '🏠 Building insulation',
  'insulation.title':
    'One-off upgrade: halves the electric heating and cooling load of every building',
  'insulation.buy': 'Buy for {cost} ⌁',
  'insulation.bought': 'installed',
  'newGame.title': 'New city',
  'newGame.mapSize': 'Map size',
  'newGame.difficulty': 'Difficulty',
  'newGame.difficulty.easy': 'Easy',
  'newGame.difficulty.normal': 'Normal',
  'newGame.difficulty.hard': 'Hard',
  'newGame.seed': 'Seed',
  'newGame.seedPlaceholder': 'random',
  'newGame.start': 'Found city',
  'newGame.cancel': 'Cancel',
  'newGame.warning': 'Starting a new city erases the current one.',
  'newCity.label': 'New city',
  'newCity.confirm': 'Start a new city? The current one will be erased.',

  'overlay.label': 'Overlay',
  'overlay.off': 'Off',
  'overlay.supply': 'Supply',
  'overlay.demand': 'Demand',
  'overlay.off.title': 'No overlay',
  'overlay.supply.title':
    'Supply status: green = supplied, orange = undersupplied, red = not connected',
  'overlay.demand.title': 'Growth demand per zone: red = none, green = high',
  'overlay.services': 'Services',
  'overlay.services.title': 'Fire and police coverage of every building',
  'overlay.traffic': 'Traffic',
  'overlay.traffic.title': 'Traffic load per road tile: green = free, red = jammed',
  'overlay.deliveries': 'Deliveries',
  'overlay.deliveries.title':
    'Shops by delivery state: green = supplied, orange = due, red = unsupplied; depots blue',
  'overlay.transit': 'Transit',
  'overlay.transit.title': 'Bus coverage: green = covered, stops by service state',

  'rejection.notEnoughMoney': 'Not enough money',
  'rejection.tileOccupied': 'This tile is already occupied',
  'rejection.nothingToUndo': 'Nothing to undo',
  'rejection.noPlantSelected': 'No plant selected',
  'rejection.needsRiverTile': 'Run-of-river plants must stand on a river tile',
  'rejection.needsLakeShore': 'Pumped storage must stand on the lake shore',
  'rejection.needsSeaTile': 'Tidal plants must stand on a sea tile',
  'rejection.needsCoast': 'Tidal plants need the shore: pick a sea tile touching land',
  'rejection.needsHotspot': 'A geothermal plant needs a hotspot tile',
  'rejection.cannotBuildOnWater': 'Cannot build on water',
  'rejection.needsLineSite': 'Power lines need free land, a road or water',
  'rejection.needsRoad': 'Needs a road next to it',
  'rejection.needsRoadTile': 'Bus stops go on road tiles',
  'rejection.alreadyInsulated': 'Building insulation is already installed',
  'rejection.tooSteep': 'Too steep to build on',

  'footer.hint': 'right mouse/WASD: pan · wheel: zoom · Q/E: rotate',
  'footer.help': 'Help',
  'footer.imprint': 'Imprint',

  'help.title': 'How to play',
  'help.goal.title': 'Goal',
  'help.goal.body':
    'Grow a happy city powered entirely by renewable energy. Generation fluctuates with sun and wind — keep it in balance with consumption, or buildings go dark, happiness drops and growth stops.',
  'help.build.title': 'Building',
  'help.build.body':
    'Drag roads, then paint residential, commercial and retail zones next to them. Buildings appear on their own when there is demand (see the R/C/S bars) and densify over time — but only while they are fully supplied with energy.',
  'help.energy.title': 'Energy',
  'help.energy.body':
    'Plants supply only what power lines connect to them (see Grid and power lines). Solar peaks at noon and suffers under clouds; wind follows the weather day and night. Batteries store the midday surplus for the evening; the biogas plant is dispatchable backup — reliable but expensive to run, and it only fires when sun, wind, water and storage cannot cover the load, so it usually sits on standby. Dense buildings add rooftop PV automatically. The hydrogen plant electrolyses surplus that batteries, pumped storage and the export link cannot absorb: it fills a large tank, re-electrifies through its fuel cell in a lull, and sells hydrogen for profit once the tank is full — curtailed energy becomes income. The transmission link trades at a spot price that follows the region: sunny, windy hours are cheap, calm overcast evenings dear — the dashed line in the energy graph. With market trading on, your storage sells its top charge at scarcity prices and buys cheap regional surplus. A tidal plant on the coast is fully predictable — four generation peaks and four slack-water gaps a day, drifting slowly against the clock — so storage is what bridges the slack. The same coast also carries offshore wind turbines and raises the happiness of buildings with a sea view.',
  'help.grid.title': 'Grid and power lines',
  'help.grid.body':
    'Plants only supply buildings connected to them. Draw power lines (⚡, key L) from a plant along your streets — they run over roads and across water. Every energised line tile and every plant connects buildings within three tiles. A line that does not touch a plant carries nothing; the supply overlay shows what is connected. Cities from before power lines got lines along their roads for free.',
  'help.water.title': 'Water and hydro',
  'help.water.body':
    'Every map has a river, a lake and a sea along one edge. Roads cross the river as bridges (pricier per tile) but stop at the coast. A run-of-river plant on the river generates day and night — more after rainy spells, less in a drought. Pumped storage on the lake shore is a large but slower store that fills after your batteries.',
  'help.seasons.title': 'Seasons, heating and cooling',
  'help.seasons.body':
    'A year has four seasons of five days each. Summer brings long days and strong sun; winter brings short days, weak PV, more cloud and wind, and cold. Every building heats electrically, so the heating load rises with the cold — the winter evening is the hardest hour of the year. In summer every building cools electrically, so the cooling load peaks in the late afternoon as PV fades. Snow that falls in winter melts into the river in spring. Building insulation is a one-off upgrade that halves the heating and cooling load.',
  'help.ev.title': 'E-mobility',
  'help.ev.body':
    'Your citizens drive EVs. Home charging peaks in the evening — right when solar is gone. Charging hubs shift the load into the sunny midday, and the smart-charging upgrade follows the surplus automatically.',
  'help.traffic.title': 'Traffic',
  'help.traffic.body':
    'Every car commutes: home to work in the morning, back in the evening, along the fastest route it can find. A lane holds two cars; queues form behind full tiles and long commutes cost happiness. Avenues carry four cars per lane at higher speed and can be drawn over existing streets. The traffic overlay shows where it jams.',
  'help.deliveries.title': 'Deliveries',
  'help.deliveries.body':
    'Shops need goods. A logistics depot sends three electric vans on tours along the roads; a shop that has not seen a van for a day and a half stops growing. Vans queue in traffic like cars and charge at the depot, so keep it powered and in reach of your retail streets. The deliveries overlay shows who is due.',
  'help.transit.title': 'Transit',
  'help.transit.body':
    'Mark bus stops on your roads and build a bus depot. Three electric buses tour the stops that have waited longest; a stop a bus visited recently counts as served and covers the roads around it. A commuter with a served stop near home and near work leaves the car at home, which eases traffic and the evening charging peak. Too many stops for one depot leave some unserved.',
  'help.services.title': 'City services',
  'help.services.body':
    'Fire and police stations protect every building within their ring, but only while connected to the grid. Buildings need fire cover to reach the highest density; without police cover, happiness and tax income fall once the city has 100 residents. The services overlay shows who is covered.',
  'help.controls.title': 'Controls',
  'help.controls.body':
    'Left mouse: use the selected tool (drag for roads and zones). Right or middle mouse drag: pan. Mouse wheel: zoom. Q/E: rotate the view. WASD/arrows: pan. Ctrl+S: quick-save. The game autosaves every 30 seconds.',
  'help.icons.title': 'Warning icons',
  'help.icons.body':
    'A red bolt above a building means it is not connected to any plant; an orange bolt means the grid cannot cover its demand right now.',
  'help.nature.title': 'Woods and nature',
  'help.nature.body':
    'Every map starts with woodland. Building through it fells the trees for a fee that scales with how grown they are, so a road through the forest costs more than one over open land — the bulldozer clears bare woods for the same fee. Woods within five tiles of a building raise happiness, on top of parks. You can plant new woods by the patch (🌲); saplings take a few in-game days to mature. The catch: trees slow the wind, so a turbine standing in closed forest loses up to 30 % of its output. Plant the woods where people live, keep them clear of your wind park.',
  'help.terrain.title': 'Hills and slopes',
  'help.terrain.body':
    'Every map has hills. Steep slopes cannot be built on, and building on a gentle slope costs extra. Wind turbines generate more on high ground, run-of-river plants gain from a drop in the river, and pumped storage stores more the higher it sits above the lake.',

  'imprint.title': 'Imprint',
  'imprint.according': 'Information in accordance with § 5 DDG',
  'imprint.contact': 'Contact',
  'imprint.responsible': 'Responsible for content',
  'imprint.disclaimer.title': 'Disclaimer',
  'imprint.disclaimer.body':
    'This is a free, open-source browser game (MIT license). Despite careful review, no liability is assumed for external links; their content is the sole responsibility of their operators.',

  'modal.close': 'Close',

  'tutorial.welcome.title': 'Welcome to Voltopia!',
  'tutorial.welcome.body':
    'Your city will run entirely on renewable energy. Let’s get the first neighborhood powered up.',
  'tutorial.road.title': 'Build a road',
  'tutorial.road.body':
    'Open the build menu at the bottom, pick the road tool (🛣 or key 2) and drag a line across the grass. Everything grows along roads.',
  'tutorial.zone.title': 'Zone some homes',
  'tutorial.zone.body':
    'Pick the residential tool (🏠 or key 3) and drag a small rectangle next to your road.',
  'tutorial.power.title': 'Provide power',
  'tutorial.power.body':
    'From the Energy tab, place a wind turbine (🌀, key 7) or a solar farm (☀️, key 6) next to your road. The ring shows how far it reaches on its own — just a few tiles.',
  'tutorial.grid.title': 'Connect the grid',
  'tutorial.grid.body':
    'Draw a power line (⚡, key L) from the plant along your road. Buildings within three tiles of a connected line get power.',
  'tutorial.growth.title': 'Watch it grow',
  'tutorial.growth.body':
    'With demand, roads and power in place, the first houses will appear on their own. Give it a moment (▶▶▶ speeds things up).',
  'tutorial.night.title': 'Survive the night',
  'tutorial.night.body':
    'Solar dies at sunset — add a battery (🔋) to store the midday surplus, and check the energy panel. Good luck, mayor!',
  'tutorial.next': 'Next',
  'tutorial.done': 'Let’s go!',
  'tutorial.skip': 'Skip tutorial',
  'tutorial.waiting': '… waiting',

  'win.title': 'Voltopia shines!',
  'win.body':
    'Every goal achieved: your city runs on sun, wind and clever planning. Keep building — or start a bigger map and do it again on hard.',
  'win.continue': 'Keep playing',
  'stats.title': 'City statistics',
  'stats.empty': 'Come back after your first full day — statistics are recorded daily.',
  'stats.population': 'Population & jobs',
  'stats.energy': 'Energy (daily average per tick)',
  'stats.money': 'Treasury',
  'stats.happiness': 'Happiness',
  'stats.temperature': 'Temperature (daily mean, °C)',
  'footer.stats': 'Statistics',
  'settings.title': 'Settings',
  'settings.sound': 'Sound',
  'settings.soundEnabled': 'Sound effects',
  'settings.volume': 'Volume',
  'settings.graphics': 'Graphics',
  'settings.shadows': 'Shadows',
  'settings.reducedMotion': 'Reduce motion',
  'settings.theme': 'HUD theme',
  'settings.theme.dark': 'Dark',
  'settings.theme.light': 'Light',
  'settings.saveSlots': 'Save slots',
  'settings.slot': 'Slot',
  'settings.save': 'Save',
  'settings.load': 'Load',
  'settings.saved': 'Saved.',
  'settings.transfer': 'Backup',
  'settings.export': 'Export save file',
  'settings.import': 'Import save file',
  'footer.settings': 'Settings',

  'goals.title': 'Goals',
  'goal.firstPower.title': 'Switched on',
  'goal.firstPower.body': 'Build your first power plant.',
  'goal.population100.title': 'Village',
  'goal.population100.body': 'Reach 100 residents.',
  'goal.population500.title': 'Town',
  'goal.population500.body': 'Reach 500 residents.',
  'goal.cleanDay.title': 'Self-sufficient',
  'goal.cleanDay.body': 'A full day without deficits or grid imports (50+ residents).',
  'goal.evFleet.title': 'Electric avenue',
  'goal.evFleet.body': '30 electric vehicles on your roads.',
  'goal.exporter.title': 'Power exporter',
  'goal.exporter.body': 'Export 20,000 energy units to the grid.',
  'goal.hydroPower.title': 'Blue power',
  'goal.hydroPower.body': 'Build a run-of-river plant on the river.',
  'goal.tidalPower.title': 'Tidal power',
  'goal.tidalPower.body': 'Build a tidal plant on the coast.',
  'goal.geothermalBaseload.title': 'Baseload',
  'goal.geothermalBaseload.body': 'Cover 15 % of your generation from geothermal for a full day.',
  'goal.gridBuilder.title': 'Grid builder',
  'goal.gridBuilder.body': 'Build your first power line.',
  'goal.winterResilience.title': 'Winter-proof',
  'goal.winterResilience.body':
    'Get through a whole winter without a single undersupplied tick (50+ residents).',
  'goal.summerResilience.title': 'Heat-proof',
  'goal.summerResilience.body':
    'Get through a whole summer without a single undersupplied tick (50+ residents).',
  'goal.safeCity.title': 'Safe city',
  'goal.safeCity.body': 'Fire and police cover 90% of buildings (100+ residents).',
  'goal.safeCity.progress': 'Fire {fire} % · Police {police} %',
  'goal.freeFlow.title': 'Free flow',
  'goal.freeFlow.body': 'A whole day of commutes under 1.15× free flow (300+ residents).',
  'goal.wellStocked.title': 'Well stocked',
  'goal.wellStocked.body': 'A whole day with 95% of shops supplied (20+ shops).',
  'goal.modalShift.title': 'Modal shift',
  'goal.modalShift.body': 'A whole day with 30% of commuters on the bus (300+ residents).',

  // Budget panel and tile inspector.
  'budget.title': 'Budget',
  'budget.dayUnit': 'day',
  'budget.income': 'Income',
  'budget.expenses': 'Upkeep & costs',
  'budget.tax': 'Taxes',
  'budget.export': 'Grid export',
  'budget.hydrogen': 'Hydrogen sales',
  'budget.roads': 'Roads & power lines',
  'budget.avenues': 'Avenues',
  'budget.busStops': 'Bus stops',
  'budget.biogasFuel': 'Biogas fuel',
  'budget.import': 'Grid import',
  'budget.note': 'Upkeep is a money cost only — it does not consume energy.',

  'inspect.bridge': 'Bridge',
  'inspect.plant': 'Plant',
  'inspect.density': 'density',
  'inspect.vacantLot': 'vacant lot',
  'inspect.river': 'River',
  'inspect.lake': 'Lake',
  'inspect.sea': 'Sea',
  'inspect.empty': 'Open land',
  'inspect.section.money': 'Money',
  'inspect.section.energy': 'Energy',
  'inspect.section.growth': 'Demand & growth',
  'inspect.section.services': 'Services',
  'inspect.section.traffic': 'Traffic',
  'inspect.section.deliveries': 'Deliveries',
  'inspect.section.transit': 'Transit',
  'inspect.roadClass': 'Road',
  'inspect.street': 'Street',
  'inspect.avenue': 'Avenue',
  'inspect.trafficLoad': 'Load',
  'inspect.laneCapacity': 'Cars per lane',
  'inspect.deliveryState': 'Status',
  'inspect.delivery.supplied': 'supplied',
  'inspect.delivery.due': 'due',
  'inspect.delivery.unsupplied': 'not supplied',
  'inspect.lastDelivery': 'Last delivery',
  'inspect.lastDelivery.daysAgo': '{days} days ago',
  'inspect.lastDelivery.never': 'never',
  'inspect.depot.vans': 'Vans',
  'inspect.depot.vansValue': '{driving} on the road · {charging} charging · {total} total',
  'inspect.depot.shopsInReach': 'Shops in reach',
  'inspect.busStop': 'Bus stop',
  'inspect.stopState': 'Service',
  'inspect.stop.served': 'served',
  'inspect.stop.due': 'due',
  'inspect.stop.unserved': 'unserved',
  'inspect.lastBus': 'Last bus',
  'inspect.lastBus.hoursAgo': '{hours} h ago',
  'inspect.transitCovered': 'Covered',
  'inspect.buses': 'Buses',
  'inspect.buses.value': '{driving} on the road · {charging} charging · {total} total',
  'inspect.stopsInReach': 'Stops in reach',
  'inspect.upkeep': 'Upkeep',
  'inspect.tax': 'Tax contribution',
  'inspect.net': 'Net',
  'inspect.consumption': 'Consumption',
  'inspect.nowPeak': 'now / peak load of this tile',
  'inspect.loadFactor': 'Load profile now',
  'inspect.generation': 'Generation',
  'inspect.nowNameplate': 'now / nameplate output',
  'inspect.tideFactor': 'Tidal current',
  'inspect.siteFactor': 'Site factor',
  'inspect.storedEnergy': 'State of charge',
  'inspect.supplyStatus': 'Supply',
  'inspect.connected': 'Grid connection',
  'inspect.yes': 'yes',
  'inspect.no': 'no',
  'inspect.demand': 'Zone demand',
  'inspect.residents': 'Residents',
  'inspect.troubled': 'Ticks undersupplied',
  'inspect.growthOk': 'Nothing blocks growth here',
  'inspect.supply.notConnected': 'not connected',
  'inspect.supply.undersupplied': 'undersupplied',
  'inspect.supply.supplied': 'supplied',
  'inspect.fire': 'Fire cover',
  'inspect.police': 'Police cover',
  'inspect.covered': 'covered',
  'inspect.uncovered': 'not covered',
  'inspect.stationStatus': 'Station',
  'inspect.stationActive': 'active',
  'inspect.stationUnpowered': 'unpowered, covers nothing',
  'inspect.blocker.noRoad': 'No road next to this tile',
  'inspect.blocker.lowDemand': 'Too little demand for this zone',
  'inspect.blocker.notConnected': 'No connected power line in reach',
  'inspect.blocker.undersupplied': 'Not enough energy right now',
  'inspect.blocker.tooYoung': 'Building too young to densify',
  'inspect.blocker.maxDensity': 'Already at maximum density',
  'inspect.blocker.cityUnhappy': 'City too unhappy to grow',
  'inspect.blocker.notLand': 'Cannot build on water',
  'inspect.blocker.noFireCoverage': 'No fire station in reach for the next density',
  'inspect.blocker.noDeliveries': 'No deliveries — needs a powered logistics depot in reach',
  'inspector.elevation': 'Elevation',
  'inspector.steepSlope': 'Steep slope — cannot be built on',
  'inspector.terrain': 'Terrain',
  'inspector.terrainBonus': 'Terrain bonus',
} as const;

export type TranslationKey = keyof typeof en;

const de: Record<TranslationKey, string> = {
  'boot.loading': 'Voltopia lädt…',
  'webgl.fallback':
    '3D-Ansicht nicht verfügbar (WebGL wird hier nicht unterstützt) — die Simulation läuft weiter.',

  'hud.funds': 'Guthaben',
  'hud.residents': 'Einwohner',
  'hud.jobs': 'Jobs',
  'hud.happiness': 'Zufriedenheit',
  'hud.traffic': 'Verkehr',
  'hud.traffic.title': '{label} · {driving} Autos unterwegs · {avenues} % Alleen',
  'hud.deliveries': 'Lieferungen',
  'hud.deliveries.title': '{supplied} von {shops} Läden beliefert · {vans} Lieferwagen unterwegs',
  'hud.transit': 'ÖPNV',
  'hud.transit.title':
    '{riders} Fahrgäste · {buses} Busse unterwegs · {served} von {stops} Haltestellen bedient',
  'traffic.flowing': 'fließend',
  'traffic.slow': 'zäh',
  'traffic.jammed': 'Stau',
  'hud.day': 'Tag {n}',
  'hud.weather.title': 'Jahreszeit und Temperatur · Bewölkung / Windgeschwindigkeit',
  'season.spring': 'Frühling',
  'season.summer': 'Sommer',
  'season.autumn': 'Herbst',
  'season.winter': 'Winter',
  'hud.season': '{season} {day}/{days} · {temperature} °C',
  'hud.tide': 'Tide',
  'hud.tide.title': 'Tide: {state} · Strömung {percent} %',
  'tide.rising': 'auflaufend',
  'tide.falling': 'ablaufend',
  'tide.high': 'Hochwasser',
  'tide.low': 'Niedrigwasser',
  'hud.demand.title': 'Nachfrage: Wohnen / Gewerbe / Handel',
  'hud.details': 'Details',
  'hud.section.city': 'Stadt',

  'speed.pause': 'Pause',
  'speed.normal': 'Normale Geschwindigkeit',
  'speed.fast': 'Schnell (3x)',

  'tool.select': 'Auswählen / bewegen',
  'tool.road': 'Straße',
  'tool.avenue': 'Allee',
  'tool.power-line': 'Stromleitung',
  'tool.bus-stop': 'Haltestelle',
  'tool.zone-residential': 'Wohngebiet',
  'tool.zone-commercial': 'Gewerbe',
  'tool.zone-retail': 'Einzelhandel',
  'tool.plant-solar': 'Solarpark',
  'tool.plant-wind': 'Windrad',
  'tool.plant-battery': 'Batteriespeicher',
  'tool.plant-biogas': 'Biogasanlage',
  'tool.plant-hub': 'Ladepark',
  'tool.plant-park': 'Park',
  'tool.plant-fire': 'Feuerwehr',
  'tool.plant-police': 'Polizei',
  'tool.plant-depot': 'Logistikdepot',
  'tool.plant-busdepot': 'Busdepot',
  'tool.plant-hydro': 'Laufwasserkraftwerk',
  'tool.plant-pumped': 'Pumpspeicher',
  'tool.plant-hydrogen': 'Wasserstoffanlage',
  'tool.plant-tidal': 'Gezeitenkraftwerk',
  'tool.plant-geothermal': 'Geothermiekraftwerk',
  'tool.plant-forest': 'Wald pflanzen',
  'inspector.forest': 'Wald',
  'inspector.forest.mature': 'ausgewachsen · Rodung {fee} ⌁',
  'inspector.forest.growing': 'wächst · Rodung {fee} ⌁',
  'hud.nature': 'Natur',
  'hud.nature.title': '{share} % des Landes sind bewaldet',
  'tool.bulldoze': 'Abriss',
  'tool.undo': 'Rückgängig',
  'tool.undo.title': 'Letzte Bauaktion rückgängig machen',
  'tool.perTile': '{cost}/Feld',

  // Baumenü: Kategorie-Reiter und Tooltip-Text je Werkzeug.
  'build.category.basics': 'Basis',
  'build.category.zones': 'Gebiete',
  'build.category.energy': 'Energie',
  'build.category.services': 'Service',
  'tool.select.desc': 'Feld anklicken zum Inspizieren, ziehen bewegt die Kamera.',
  'tool.road.desc': 'Straßen verbinden die Stadt. Ziehen baut eine Linie.',
  'tool.avenue.desc':
    'Doppelte Spurkapazität und schnellere Fahrt. Über eine Straße ziehen, um sie auszubauen.',
  'tool.power-line.desc':
    'Führt Strom von Anlagen entlang der Straßen. Gebäude im Umkreis von drei Feldern einer angeschlossenen Leitung werden versorgt.',
  'tool.bus-stop.desc':
    'Haltestelle auf einer Straße. Pendler mit bedienter Haltestelle nahe Wohnung und Arbeit lassen das Auto stehen.',
  'tool.zone-residential.desc': 'Wohnhäuser. Bewohner ziehen ein, sobald Straße und Strom da sind.',
  'tool.zone-commercial.desc': 'Büros. Schaffen Arbeitsplätze für deine Bewohner.',
  'tool.zone-retail.desc': 'Läden. Halten Bewohner zufrieden und schaffen Arbeitsplätze.',
  'tool.plant-solar.desc': 'Erzeugt mit Sonnenlicht — Spitze mittags, nachts nichts.',
  'tool.plant-wind.desc':
    'Erzeugt mit Windgeschwindigkeit, Tag und Nacht. Offshore-Anlagen fangen freien Wind für einen Bonus ein, gegen einen Aufpreis beim Bau.',
  'tool.plant-battery.desc': 'Speichert Überschuss und gibt ihn ab, wenn die Erzeugung fällt.',
  'tool.plant-biogas.desc': 'Regelbare Erzeugung, verbraucht aber kostenpflichtigen Brennstoff.',
  'tool.plant-hub.desc': 'Lädt E-Autos im Umkreis. Passt zum Smart Charging.',
  'tool.plant-park.desc': 'Erhöht die Zufriedenheit in der Nähe. Erzeugt nichts.',
  'tool.plant-fire.desc':
    'Gebäude in ihrem Ring dürfen die höchste Dichte erreichen. Braucht Straße und Strom.',
  'tool.plant-police.desc':
    'Hält Zufriedenheit und Steuern in ihrem Ring hoch. Braucht Straße und Strom.',
  'tool.plant-depot.desc':
    'Schickt E-Lieferwagen zu den Läden. Läden ohne Lieferung wachsen nicht weiter. Braucht Straße und Strom zum Laden.',
  'tool.plant-busdepot.desc':
    'Schickt drei Elektrobusse über deine Haltestellen. Braucht Straße und Strom zum Laden.',
  'tool.plant-hydro.desc': 'Am Fluss gebaut. Leistung folgt dem Abfluss.',
  'tool.plant-pumped.desc': 'Großer Speicher am Seeufer. Pumpt bei Überschuss hoch.',
  'tool.plant-hydrogen.desc':
    'Elektrolysiert Überschuss, den das Netz nicht aufnimmt, zu Wasserstoff, verstromt ihn in der Flaute und verkauft den Überlauf bei vollem Tank.',
  'tool.plant-tidal.desc':
    'An der Küste gebaut, erzeugt Strom aus der Gezeitenströmung: zwei Hochwasser am Tag ergeben ' +
    'vier Erzeugungsspitzen und vier Flauten dazwischen. Genau vorhersehbar, wandert aber gegen die ' +
    'Uhr. Enge Fahrwasser und die Flussmündung strömen schneller.',
  'tool.plant-forest.desc':
    'Pflanzt Setzlinge flächenweise. Sie wachsen über einige Tage, heben die Zufriedenheit in der Nähe — und bremsen den Wind für Turbinen, die darin stehen.',
  'tool.bulldoze.desc': 'Entfernt Straßen, Gebiete und Anlagen. Ziehen räumt eine Fläche.',
  'tool.undo.desc': 'Macht die letzte Bauaktion rückgängig.',

  'energy.title': 'Energie',
  'energy.solar': '☀️ Solar',
  'energy.wind': '🌀 Wind',
  'energy.hydro': '💧 Wasserkraft (Abfluss {flow}%)',
  'energy.tidal': '🌊 Gezeiten',
  'energy.biogas': '♻️ Biogas',
  'energy.standby': 'Bereitschaft',
  'energy.rooftop': '🏠 Dach-PV',
  'energy.consumption': '🏙 Verbrauch',
  'energy.charging': '🔌 E-Auto-Laden',
  'energy.heating': '🔥 Heizung',
  'energy.cooling': '❄️ Kühlung',
  'energy.surplus': 'Überschuss',
  'energy.deficit': 'Defizit',
  'energy.curtailed': 'Abgeregelt',
  'energy.import': '⤵️ Netzbezug',
  'energy.export': '⤴️ Einspeisung',
  'energy.storage': 'Speicher (Ladestand)',
  'energy.pumpedStorage': 'Pumpspeicher (Ladestand)',
  'energy.fuelCell': 'Brennstoffzelle',
  'energy.electrolysis': 'Elektrolyse',
  'energy.hydrogenSold': 'Wasserstoff verkauft',
  'energy.hydrogenStorage': 'Wasserstofftank',
  'energy.spot': 'Spotpreis',
  'energy.legend.price': 'Spotpreis',
  'energy.graph.label': 'Erzeugung und Verbrauch des letzten Tages',
  'energy.legend.generation': 'Erzeugung',
  'energy.legend.consumption': 'Verbrauch',

  'tax.label': 'Steuersatz',
  'smartCharging.label': '⚡ Smart Charging',
  'smartCharging.title': 'E-Auto-Laden folgt automatisch dem Erzeugungsüberschuss',
  'marketTrading.label': '📈 Stromhandel',
  'marketTrading.title':
    'Speicher handeln an der Strombörse: verkaufen ihre oberste Ladung zu Knappheitspreisen, kaufen billigen regionalen Überschuss',
  'insulation.label': '🏠 Gebäudedämmung',
  'insulation.title':
    'Einmaliges Upgrade: halbiert die elektrische Heiz- und Kühllast aller Gebäude',
  'insulation.buy': 'Kaufen für {cost} ⌁',
  'insulation.bought': 'installiert',
  'newGame.title': 'Neue Stadt',
  'newGame.mapSize': 'Kartengröße',
  'newGame.difficulty': 'Schwierigkeit',
  'newGame.difficulty.easy': 'Leicht',
  'newGame.difficulty.normal': 'Normal',
  'newGame.difficulty.hard': 'Schwer',
  'newGame.seed': 'Startwert (Seed)',
  'newGame.seedPlaceholder': 'zufällig',
  'newGame.start': 'Stadt gründen',
  'newGame.cancel': 'Abbrechen',
  'newGame.warning': 'Eine neue Stadt löscht die aktuelle Stadt.',
  'newCity.label': 'Neue Stadt',
  'newCity.confirm': 'Eine neue Stadt beginnen? Die aktuelle Stadt wird gelöscht.',

  'overlay.label': 'Overlay',
  'overlay.off': 'Aus',
  'overlay.supply': 'Versorgung',
  'overlay.demand': 'Nachfrage',
  'overlay.off.title': 'Kein Overlay',
  'overlay.supply.title':
    'Versorgungsstatus: grün = versorgt, orange = unterversorgt, rot = nicht angeschlossen',
  'overlay.demand.title': 'Wachstumsnachfrage pro Zone: rot = keine, grün = hoch',
  'overlay.services': 'Dienste',
  'overlay.services.title': 'Feuerwehr- und Polizeiabdeckung jedes Gebäudes',
  'overlay.traffic': 'Verkehr',
  'overlay.traffic.title': 'Verkehrslast pro Straßenkachel: grün = frei, rot = Stau',
  'overlay.deliveries': 'Lieferungen',
  'overlay.deliveries.title':
    'Läden nach Lieferstatus: grün = beliefert, orange = fällig, rot = unversorgt; Depots blau',
  'overlay.transit': 'ÖPNV',
  'overlay.transit.title': 'Busabdeckung: grün = abgedeckt, Haltestellen nach Bedienung',

  'rejection.notEnoughMoney': 'Nicht genug Geld',
  'rejection.tileOccupied': 'Dieses Feld ist bereits belegt',
  'rejection.nothingToUndo': 'Nichts rückgängig zu machen',
  'rejection.noPlantSelected': 'Keine Anlage ausgewählt',
  'rejection.needsRiverTile': 'Laufwasserkraftwerke müssen auf einem Flussfeld stehen',
  'rejection.needsLakeShore': 'Pumpspeicher müssen am Seeufer stehen',
  'rejection.needsSeaTile': 'Gezeitenkraftwerke müssen auf einem Meeresfeld stehen',
  'rejection.needsCoast':
    'Gezeitenkraftwerke brauchen die Küste: ein Meeresfeld mit Landkontakt wählen',
  'rejection.needsHotspot': 'Ein Geothermiekraftwerk braucht ein Hotspot-Feld',
  'rejection.cannotBuildOnWater': 'Auf Wasser kann nicht gebaut werden',
  'rejection.needsLineSite': 'Leitungen brauchen freies Land, eine Straße oder Wasser',
  'rejection.needsRoad': 'Braucht eine Straße daneben',
  'rejection.needsRoadTile': 'Haltestellen gehören auf Straßenkacheln',
  'rejection.alreadyInsulated': 'Die Gebäudedämmung ist bereits installiert',
  'rejection.tooSteep': 'Zu steil zum Bebauen',

  'footer.hint': 'rechte Maustaste/WASD: bewegen · Mausrad: zoomen · Q/E: drehen',
  'footer.help': 'Hilfe',
  'footer.imprint': 'Impressum',

  'help.title': 'Spielanleitung',
  'help.goal.title': 'Ziel',
  'help.goal.body':
    'Baue eine zufriedene Stadt, die vollständig mit erneuerbarer Energie läuft. Die Erzeugung schwankt mit Sonne und Wind — halte sie mit dem Verbrauch im Gleichgewicht, sonst werden Gebäude dunkel, die Zufriedenheit sinkt und das Wachstum stoppt.',
  'help.build.title': 'Bauen',
  'help.build.body':
    'Ziehe Straßen und male daneben Wohn-, Gewerbe- und Einzelhandelszonen. Gebäude entstehen von selbst, wenn Nachfrage besteht (siehe die R/C/S-Balken), und verdichten sich mit der Zeit — aber nur, solange sie vollständig mit Energie versorgt sind.',
  'help.energy.title': 'Energie',
  'help.energy.body':
    'Anlagen versorgen nur, was Stromleitungen mit ihnen verbinden (siehe Netz und Leitungen). Solar liefert mittags am meisten und leidet unter Wolken; Wind folgt dem Wetter, Tag und Nacht. Batterien speichern den Mittagsüberschuss für den Abend; die Biogasanlage ist regelbare Reserve — zuverlässig, aber teuer im Betrieb, und sie springt nur an, wenn Sonne, Wind, Wasser und Speicher die Last nicht decken; meist steht sie in Bereitschaft. Dichte Gebäude bekommen automatisch Dach-PV. Die Wasserstoffanlage elektrolysiert Überschuss, den Batterien, Pumpspeicher und die Netzeinspeisung nicht aufnehmen können: Sie füllt einen großen Tank, verstromt in der Flaute über ihre Brennstoffzelle und verkauft bei vollem Tank Wasserstoff mit Gewinn — abgeregelte Energie wird zu Einnahmen. Die Netzleitung handelt zum Spotpreis, der der Region folgt: sonnige, windige Stunden sind billig, windstille bedeckte Abende teuer — die gestrichelte Linie im Energie-Graphen. Mit aktiviertem Stromhandel verkaufen deine Speicher ihre oberste Ladung zu Knappheitspreisen und kaufen billigen regionalen Überschuss. Ein Gezeitenkraftwerk an der Küste ist vollständig vorhersagbar — vier Erzeugungsspitzen und vier Stillwasserphasen am Tag, die langsam gegen die Uhr wandern — deshalb überbrückt der Speicher die Flaute. Dieselbe Küste trägt auch Offshore-Windräder und steigert die Zufriedenheit von Gebäuden mit Meerblick.',
  'help.grid.title': 'Netz und Leitungen',
  'help.grid.body':
    'Anlagen versorgen nur Gebäude, die mit ihnen verbunden sind. Ziehe Stromleitungen (⚡, Taste L) von einer Anlage entlang deiner Straßen — sie laufen über Straßen und über Wasser. Jedes angeschlossene Leitungsfeld und jede Anlage versorgt Gebäude im Umkreis von drei Feldern. Eine Leitung ohne Anlage führt keinen Strom; das Versorgungs-Overlay zeigt, was angeschlossen ist. Städte aus der Zeit vor den Leitungen haben ihre Leitungen entlang der Straßen geschenkt bekommen.',
  'help.water.title': 'Wasser und Wasserkraft',
  'help.water.body':
    'Jede Karte hat einen Fluss, einen See und ein Meer an einem Rand. Straßen überqueren den Fluss als Brücken (teurer pro Feld), enden aber an der Küste. Ein Laufwasserkraftwerk auf dem Fluss erzeugt Tag und Nacht Strom — mehr nach Regenphasen, weniger in Trockenzeiten. Ein Pumpspeicher am Seeufer ist ein großer, aber trägerer Speicher, der sich nach den Batterien füllt.',
  'help.seasons.title': 'Jahreszeiten, Heizung und Kühlung',
  'help.seasons.body':
    'Ein Jahr hat vier Jahreszeiten zu je fünf Tagen. Der Sommer bringt lange Tage und kräftige Sonne; der Winter kurze Tage, schwache PV, mehr Wolken und Wind — und Kälte. Alle Gebäude heizen elektrisch, die Heizlast steigt mit der Kälte: Der Winterabend ist die schwerste Stunde des Jahres. Im Sommer kühlen alle Gebäude elektrisch: Die Kühllast erreicht ihre Spitze am späten Nachmittag, wenn die PV nachlässt. Schnee aus dem Winter schmilzt im Frühling in den Fluss. Die Gebäudedämmung ist ein einmaliges Upgrade, das die Heiz- und Kühllast halbiert.',
  'help.ev.title': 'E-Mobilität',
  'help.ev.body':
    'Deine Bürger fahren E-Autos. Das Laden zu Hause hat abends seinen Höhepunkt — genau dann, wenn die Sonne weg ist. Ladeparks verschieben die Last in den sonnigen Mittag, und das Smart-Charging-Upgrade folgt dem Überschuss automatisch.',
  'help.traffic.title': 'Verkehr',
  'help.traffic.body':
    'Jedes Auto pendelt: morgens zur Arbeit, abends zurück, auf der schnellsten Route, die es findet. Eine Spur fasst zwei Autos; hinter vollen Kacheln bilden sich Staus, und lange Pendelzeiten kosten Zufriedenheit. Alleen fassen vier Autos pro Spur bei höherem Tempo und lassen sich über bestehende Straßen ziehen. Das Verkehrs-Overlay zeigt, wo es stockt.',
  'help.deliveries.title': 'Lieferverkehr',
  'help.deliveries.body':
    'Läden brauchen Waren. Ein Logistikdepot schickt drei E-Lieferwagen auf Touren über die Straßen; ein Laden, den anderthalb Tage kein Wagen erreicht hat, wächst nicht weiter. Lieferwagen stehen im Stau wie Autos und laden im Depot – also Strom anschließen und in Reichweite der Einkaufsstraßen bauen. Das Lieferungen-Overlay zeigt, wer fällig ist.',
  'help.transit.title': 'ÖPNV',
  'help.transit.body':
    'Setze Haltestellen auf deine Straßen und baue ein Busdepot. Drei Elektrobusse fahren die Haltestellen ab, die am längsten warten; eine Haltestelle mit kürzlichem Bushalt gilt als bedient und deckt die Straßen ringsum ab. Pendler mit bedienter Haltestelle nahe Wohnung und Arbeit lassen das Auto stehen, was Verkehr und abendliche Ladespitze entlastet. Zu viele Haltestellen für ein Depot bleiben teils unbedient.',
  'help.services.title': 'Stadtdienste',
  'help.services.body':
    'Feuerwehr und Polizei schützen jedes Gebäude in ihrem Ring, aber nur mit Netzanschluss. Für die höchste Dichte brauchen Gebäude Feuerwehrschutz; ohne Polizeischutz sinken Zufriedenheit und Steuereinnahmen, sobald die Stadt 100 Einwohner hat. Das Dienste-Overlay zeigt, wer abgedeckt ist.',
  'help.controls.title': 'Steuerung',
  'help.controls.body':
    'Linke Maustaste: gewähltes Werkzeug benutzen (für Straßen und Zonen ziehen). Rechte oder mittlere Maustaste ziehen: Ansicht bewegen. Mausrad: zoomen. Q/E: Ansicht drehen. WASD/Pfeile: bewegen. Strg+S: Schnellspeichern. Das Spiel speichert alle 30 Sekunden automatisch.',
  'help.icons.title': 'Warnsymbole',
  'help.icons.body':
    'Ein roter Blitz über einem Gebäude bedeutet: nicht an eine Anlage angeschlossen. Ein oranger Blitz: das Netz kann den Bedarf gerade nicht decken.',
  'help.nature.title': 'Wald und Natur',
  'help.nature.body':
    'Jede Karte startet mit Wald. Wer hindurchbaut, rodet ihn gegen eine Gebühr, die mit dem Wuchs steigt — eine Straße durch den Wald kostet also mehr als über offenes Land; die Planierraupe rodet reinen Wald zum selben Preis. Wald im Umkreis von fünf Feldern um ein Gebäude hebt die Zufriedenheit, zusätzlich zu Parks. Neuen Wald pflanzt du flächenweise (🌲); Setzlinge brauchen ein paar Spieltage bis zur Reife. Der Haken: Bäume bremsen den Wind, eine Turbine im geschlossenen Wald verliert bis zu 30 % Leistung. Pflanze den Wald dort, wo Menschen wohnen, und halte ihn vom Windpark fern.',
  'help.terrain.title': 'Hügel und Hänge',
  'help.terrain.body':
    'Jede Karte hat Hügel. Steilhänge sind nicht bebaubar, Bauen am Hang kostet einen Aufschlag. Windräder erzeugen auf Anhöhen mehr, Laufwasserkraft profitiert vom Gefälle des Flusses, und Pumpspeicher speichern umso mehr, je höher sie über dem See liegen.',

  'imprint.title': 'Impressum',
  'imprint.according': 'Angaben gemäß § 5 DDG',
  'imprint.contact': 'Kontakt',
  'imprint.responsible': 'Verantwortlich für den Inhalt',
  'imprint.disclaimer.title': 'Haftungsausschluss',
  'imprint.disclaimer.body':
    'Dies ist ein kostenloses Open-Source-Browserspiel (MIT-Lizenz). Trotz sorgfältiger Prüfung wird keine Haftung für externe Links übernommen; für deren Inhalte sind ausschließlich die jeweiligen Betreiber verantwortlich.',

  'modal.close': 'Schließen',

  'tutorial.welcome.title': 'Willkommen in Voltopia!',
  'tutorial.welcome.body':
    'Deine Stadt läuft komplett mit erneuerbarer Energie. Bringen wir das erste Viertel ans Netz.',
  'tutorial.road.title': 'Baue eine Straße',
  'tutorial.road.body':
    'Öffne unten das Baumenü, wähle das Straßenwerkzeug (🛣 oder Taste 2) und ziehe eine Linie übers Gras. Alles wächst entlang von Straßen.',
  'tutorial.zone.title': 'Weise Wohngebiete aus',
  'tutorial.zone.body':
    'Nimm das Wohngebiets-Werkzeug (🏠 oder Taste 3) und ziehe ein kleines Rechteck neben deine Straße.',
  'tutorial.power.title': 'Sorge für Strom',
  'tutorial.power.body':
    'Platziere aus dem Reiter Energie ein Windrad (🌀, Taste 7) oder einen Solarpark (☀️, Taste 6) neben deiner Straße. Der Ring zeigt, wie weit die Anlage allein reicht — nur ein paar Felder.',
  'tutorial.grid.title': 'Schließe das Netz an',
  'tutorial.grid.body':
    'Ziehe eine Stromleitung (⚡, Taste L) von der Anlage entlang deiner Straße. Gebäude im Umkreis von drei Feldern einer angeschlossenen Leitung bekommen Strom.',
  'tutorial.growth.title': 'Sieh zu, wie es wächst',
  'tutorial.growth.body':
    'Mit Nachfrage, Straßen und Strom entstehen die ersten Häuser von selbst. Gib ihnen einen Moment (▶▶▶ beschleunigt).',
  'tutorial.night.title': 'Überstehe die Nacht',
  'tutorial.night.body':
    'Solar endet mit dem Sonnenuntergang — baue einen Batteriespeicher (🔋) für den Mittagsüberschuss und behalte das Energie-Panel im Blick. Viel Erfolg!',
  'tutorial.next': 'Weiter',
  'tutorial.done': 'Los geht’s!',
  'tutorial.skip': 'Tutorial überspringen',
  'tutorial.waiting': '… warte',

  'win.title': 'Voltopia strahlt!',
  'win.body':
    'Alle Ziele erreicht: Deine Stadt läuft mit Sonne, Wind und kluger Planung. Bau weiter — oder starte eine größere Karte auf Schwer.',
  'win.continue': 'Weiterspielen',
  'stats.title': 'Stadtstatistik',
  'stats.empty':
    'Schau nach dem ersten vollen Tag wieder vorbei — Statistiken werden täglich erfasst.',
  'stats.population': 'Bevölkerung & Jobs',
  'stats.energy': 'Energie (Tagesdurchschnitt pro Tick)',
  'stats.money': 'Stadtkasse',
  'stats.happiness': 'Zufriedenheit',
  'stats.temperature': 'Temperatur (Tagesmittel, °C)',
  'footer.stats': 'Statistik',
  'settings.title': 'Einstellungen',
  'settings.sound': 'Ton',
  'settings.soundEnabled': 'Soundeffekte',
  'settings.volume': 'Lautstärke',
  'settings.graphics': 'Grafik',
  'settings.shadows': 'Schatten',
  'settings.reducedMotion': 'Bewegung reduzieren',
  'settings.theme': 'HUD-Design',
  'settings.theme.dark': 'Dunkel',
  'settings.theme.light': 'Hell',
  'settings.saveSlots': 'Spielstände',
  'settings.slot': 'Slot',
  'settings.save': 'Speichern',
  'settings.load': 'Laden',
  'settings.saved': 'Gespeichert.',
  'settings.transfer': 'Sicherung',
  'settings.export': 'Spielstand exportieren',
  'settings.import': 'Spielstand importieren',
  'footer.settings': 'Einstellungen',

  'goals.title': 'Ziele',
  'goal.firstPower.title': 'Eingeschaltet',
  'goal.firstPower.body': 'Baue dein erstes Kraftwerk.',
  'goal.population100.title': 'Dorf',
  'goal.population100.body': 'Erreiche 100 Einwohner.',
  'goal.population500.title': 'Stadt',
  'goal.population500.body': 'Erreiche 500 Einwohner.',
  'goal.cleanDay.title': 'Autark',
  'goal.cleanDay.body': 'Ein ganzer Tag ohne Defizit und Netzbezug (ab 50 Einwohnern).',
  'goal.evFleet.title': 'Unter Strom',
  'goal.evFleet.body': '30 Elektroautos auf deinen Straßen.',
  'goal.exporter.title': 'Stromexporteur',
  'goal.exporter.body': 'Speise 20.000 Energieeinheiten ins Netz ein.',
  'goal.hydroPower.title': 'Wasserkraft',
  'goal.hydroPower.body': 'Baue ein Laufwasserkraftwerk am Fluss.',
  'goal.tidalPower.title': 'Gezeitenkraft',
  'goal.tidalPower.body': 'Baue ein Gezeitenkraftwerk an der Küste.',
  'goal.geothermalBaseload.title': 'Grundlast',
  'goal.geothermalBaseload.body':
    'Decke einen ganzen Tag lang 15 % deiner Erzeugung mit Geothermie.',
  'goal.gridBuilder.title': 'Unter Strom',
  'goal.gridBuilder.body': 'Baue deine erste Stromleitung.',
  'goal.winterResilience.title': 'Winterfest',
  'goal.winterResilience.body':
    'Überstehe einen ganzen Winter ohne einen einzigen unterversorgten Tick (ab 50 Einwohnern).',
  'goal.summerResilience.title': 'Hitzefest',
  'goal.summerResilience.body':
    'Überstehe einen ganzen Sommer ohne einen einzigen unterversorgten Tick (ab 50 Einwohnern).',
  'goal.safeCity.title': 'Sichere Stadt',
  'goal.safeCity.body': 'Feuerwehr und Polizei decken 90 % der Gebäude ab (ab 100 Einwohnern).',
  'goal.safeCity.progress': 'Feuerwehr {fire} % · Polizei {police} %',
  'goal.freeFlow.title': 'Freie Fahrt',
  'goal.freeFlow.body':
    'Ein ganzer Tag mit Pendelzeiten unter dem 1,15-fachen der freien Fahrt (ab 300 Einwohnern).',
  'goal.wellStocked.title': 'Gut versorgt',
  'goal.wellStocked.body': 'Einen ganzen Tag lang 95 % der Läden beliefert (ab 20 Läden).',
  'goal.modalShift.title': 'Verkehrswende',
  'goal.modalShift.body': 'Einen ganzen Tag lang 30 % der Pendler im Bus (ab 300 Einwohnern).',

  // Budget-Panel und Kachel-Inspektor.
  'budget.title': 'Budget',
  'budget.dayUnit': 'Tag',
  'budget.income': 'Einnahmen',
  'budget.expenses': 'Unterhalt & Kosten',
  'budget.tax': 'Steuern',
  'budget.export': 'Netzeinspeisung',
  'budget.hydrogen': 'Wasserstoffverkauf',
  'budget.roads': 'Straßen & Leitungen',
  'budget.avenues': 'Alleen',
  'budget.busStops': 'Haltestellen',
  'budget.biogasFuel': 'Biogas-Brennstoff',
  'budget.import': 'Netzbezug',
  'budget.note': 'Unterhalt kostet nur Geld – er verbraucht keine Energie.',

  'inspect.bridge': 'Brücke',
  'inspect.plant': 'Anlage',
  'inspect.density': 'Dichte',
  'inspect.vacantLot': 'unbebaut',
  'inspect.river': 'Fluss',
  'inspect.lake': 'See',
  'inspect.sea': 'Meer',
  'inspect.empty': 'Freies Land',
  'inspect.section.money': 'Geld',
  'inspect.section.energy': 'Energie',
  'inspect.section.growth': 'Nachfrage & Wachstum',
  'inspect.section.services': 'Dienste',
  'inspect.section.traffic': 'Verkehr',
  'inspect.section.deliveries': 'Lieferungen',
  'inspect.section.transit': 'ÖPNV',
  'inspect.roadClass': 'Straßenart',
  'inspect.street': 'Straße',
  'inspect.avenue': 'Allee',
  'inspect.trafficLoad': 'Auslastung',
  'inspect.laneCapacity': 'Autos pro Spur',
  'inspect.deliveryState': 'Status',
  'inspect.delivery.supplied': 'beliefert',
  'inspect.delivery.due': 'fällig',
  'inspect.delivery.unsupplied': 'unversorgt',
  'inspect.lastDelivery': 'Letzte Lieferung',
  'inspect.lastDelivery.daysAgo': 'vor {days} Tagen',
  'inspect.lastDelivery.never': 'nie',
  'inspect.depot.vans': 'Lieferwagen',
  'inspect.depot.vansValue': '{driving} unterwegs · {charging} laden · {total} gesamt',
  'inspect.depot.shopsInReach': 'Läden in Reichweite',
  'inspect.busStop': 'Haltestelle',
  'inspect.stopState': 'Bedienung',
  'inspect.stop.served': 'bedient',
  'inspect.stop.due': 'fällig',
  'inspect.stop.unserved': 'unbedient',
  'inspect.lastBus': 'Letzter Bus',
  'inspect.lastBus.hoursAgo': 'vor {hours} h',
  'inspect.transitCovered': 'Abgedeckt',
  'inspect.buses': 'Busse',
  'inspect.buses.value': '{driving} unterwegs · {charging} laden · {total} gesamt',
  'inspect.stopsInReach': 'Haltestellen in Reichweite',
  'inspect.upkeep': 'Unterhalt',
  'inspect.tax': 'Steuerbeitrag',
  'inspect.net': 'Saldo',
  'inspect.consumption': 'Verbrauch',
  'inspect.nowPeak': 'jetzt / Spitzenlast dieser Kachel',
  'inspect.loadFactor': 'Lastprofil jetzt',
  'inspect.generation': 'Erzeugung',
  'inspect.nowNameplate': 'jetzt / Nennleistung',
  'inspect.tideFactor': 'Gezeitenströmung',
  'inspect.siteFactor': 'Standortfaktor',
  'inspect.storedEnergy': 'Ladezustand',
  'inspect.supplyStatus': 'Versorgung',
  'inspect.connected': 'Netzanschluss',
  'inspect.yes': 'ja',
  'inspect.no': 'nein',
  'inspect.demand': 'Zonennachfrage',
  'inspect.residents': 'Einwohner',
  'inspect.troubled': 'Ticks unterversorgt',
  'inspect.growthOk': 'Nichts blockiert das Wachstum hier',
  'inspect.supply.notConnected': 'nicht angeschlossen',
  'inspect.supply.undersupplied': 'unterversorgt',
  'inspect.supply.supplied': 'versorgt',
  'inspect.fire': 'Feuerwehrschutz',
  'inspect.police': 'Polizeischutz',
  'inspect.covered': 'abgedeckt',
  'inspect.uncovered': 'nicht abgedeckt',
  'inspect.stationStatus': 'Station',
  'inspect.stationActive': 'aktiv',
  'inspect.stationUnpowered': 'ohne Strom, deckt nichts ab',
  'inspect.blocker.noRoad': 'Keine Straße an dieser Kachel',
  'inspect.blocker.lowDemand': 'Zu wenig Nachfrage für diese Zone',
  'inspect.blocker.notConnected': 'Keine angeschlossene Stromleitung in Reichweite',
  'inspect.blocker.undersupplied': 'Gerade zu wenig Energie',
  'inspect.blocker.tooYoung': 'Gebäude zu jung zum Verdichten',
  'inspect.blocker.maxDensity': 'Bereits maximale Dichte',
  'inspect.blocker.cityUnhappy': 'Stadt zu unzufrieden zum Wachsen',
  'inspect.blocker.notLand': 'Bauen auf Wasser nicht möglich',
  'inspect.blocker.noFireCoverage': 'Keine Feuerwehr in Reichweite für die nächste Dichte',
  'inspect.blocker.noDeliveries':
    'Keine Lieferungen – braucht ein versorgtes Logistikdepot in Reichweite',
  'inspector.elevation': 'Höhenstufe',
  'inspector.steepSlope': 'Steilhang — nicht bebaubar',
  'inspector.terrain': 'Gelände',
  'inspector.terrainBonus': 'Geländebonus',
};

const translations: Record<Locale, Record<TranslationKey, string>> = { en, de };

/** English text of a key, for machine-facing output (agent tools, logs). */
export function englishText(key: TranslationKey): string {
  return en[key];
}

const LOCALE_STORAGE_KEY = 'voltopia.locale';

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === 'en' || stored === 'de') return stored;
  } catch {
    // storage unavailable (private mode etc.) — fall through
  }
  return navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // best effort only
    }
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      let text: string = translations[locale][key] ?? en[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.replace(`{${name}}`, String(value));
        }
      }
      return text;
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}

/** Translate a rejection code from the simulation worker. */
export function rejectionKey(code: string): TranslationKey | null {
  const key = `rejection.${code}`;
  return key in en ? (key as TranslationKey) : null;
}
