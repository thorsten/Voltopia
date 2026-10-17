# Policies / ordinances — design

Date: 2026-10-17. Status: approved in conversation, awaiting spec review.

## Purpose

City-wide ordinances the player switches on and off: each costs money
per day, moves happiness by a fixed amount and changes one simulation
parameter. They give the finished systems (rooftop PV, EV charging,
traffic, the smart-meter rollout) a second lever beside building, and
the scenarios more ways to be won.

## Decisions

- Free toggles with running costs; no approval gate, no transition
  period. Switching back is immediate, except that buildings already
  built under the rooftop-PV mandate keep their panels.
- One registry (`src/sim/policies.ts` + `BALANCE.policies`), one
  command, one UI block, one agent tool. Affected modules read small
  accessor functions instead of `BALANCE` directly, so an inactive
  policy returns exactly today's values and existing tests stay valid.
- The fleet is electric only, so the idea document's combustion-car ban
  has no lever and is dropped. The "night-time tariff" acts on charging
  behaviour and the flexible-load pool, not on tax income (which is an
  aggregate without time of day).

## 1. Definitions and effects

```ts
export const POLICY_IDS = ['rooftopPvMandate', 'nightTariff', 'speedLimit', 'smartMeterMandate'] as const;
export type PolicyId = (typeof POLICY_IDS)[number];

SimState.policies: Record<PolicyId, boolean>;   // all false on a new city
SimState.layers.pvMandated: Uint8Array;          // 1 = built under the mandate
SimState.lastPolicyCost: number;                 // this tick's admin cost (budget line)
SimState.lastPolicySubsidy: number;              // this tick's PV subsidies (same budget line)
```

`BALANCE.policies.<id>` carries `dailyCost` (admin cost, charged per tick
as `dailyCost / TICKS_PER_DAY`), `happiness` (a constant term, signed)
and the effect parameters below. `POLICY_IDS` and `PolicyId` live in
`src/shared/types.ts` (shared must not import sim) and are re-exported
from `src/sim/policies.ts`.

| id                | effect                                                                                                                                                                                                                                                                                                                                                           | parameters                                                   | happiness                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| rooftopPvMandate  | A building that spawns (density 0 → 1 in `growthStep`) while the policy is active gets `pvMandated = 1` and the city pays `subsidyPerBuilding` once. `rooftopPeakAt(state, index)` returns `rooftopSolarPeakByDensity[density]`, or `mandatePeakDensity1` for a density-1 building with the bit set. Bulldozing or abandonment clears the bit with the building. | `subsidyPerBuilding`, `mandatePeakDensity1`                  | small minus                              |
| nightTariff       | In `decideCharging`, a non-smart car parked at home charges only between `nightStartHour` and `nightEndHour` (wrapping midnight) unless its charge is below `smartChargeFloor`; smart cars are unchanged. The smart-meter household flex share is multiplied by `flexShareFactor`.                                                                               | `nightStartHour` 22, `nightEndHour` 6, `flexShareFactor` 1.5 | small plus                               |
| speedLimit        | `carSpeedTilesPerSecond(state)` returns `speedTilesPerSecond × speedFactor` for commuter cars only (buses, vans, trains unchanged); `batteryDrainPerTile(state)` returns `batteryDrainPerTile × drainFactor`. Congestion rises on its own because trips take longer.                                                                                             | `speedFactor` 0.75, `drainFactor` 0.8                        | minus                                    |
| smartMeterMandate | `smartMeterInstallsPerDay(state)` returns `installsPerDay × installFactor`; the city pays `costPerMeter × cityCostShare` per meter. The rollout itself stays its own switch; the mandate only changes pace and price while it runs.                                                                                                                              | `installFactor` 2, `cityCostShare` 0.5                       | minus while metered coverage < 1, else 0 |

Accessors exported from `src/sim/policies.ts`:

```ts
policyActive(state, id): boolean
policyHappiness(state): number          // sum of active terms (mandate term gated on coverage)
policyDailyCost(state): number          // sum of active dailyCost
rooftopPeakAt(state, index): number
homeChargingAllowed(state, vehicleIsSmart: boolean, charge: number, tick: number): boolean
carSpeedTilesPerSecond(state): number
batteryDrainPerTile(state): number
householdFlexShare(state): number
smartMeterInstallsPerDay(state): number
smartMeterCityCost(state): number       // per meter
```

`policiesStep(state)` runs right after `economyStep`: charges
`policyDailyCost / TICKS_PER_DAY` plus this tick's subsidies, writes
`lastPolicyCost`/`lastPolicySubsidy`, marks stats dirty when non-zero.
`happinessStep` adds `policyHappiness(state)` as one more term.
Growth books the subsidy where it sets the bit (money may go negative
like other upkeep; the mandate does not block growth).

## 2. Protocol, UI, agent

- Command `{ type: 'setPolicy'; id: PolicyId; active: boolean }`;
  engine sets `state.policies[id]` and `statsDirty`. No undo.
- `GlobalStats.policies: { active: Record<PolicyId, boolean>; dailyCost: number; happiness: number }`;
  `BudgetStats.policies` = admin cost + subsidies this tick, subtracted
  in the net.
- `SaveGame.policies?: Partial<Record<PolicyId, boolean>>` and
  `SaveGame.layers.pvMandated?: ArrayBuffer`, both optional,
  `SAVE_VERSION` unchanged; absent means all off / no bits. Unknown ids
  in a save are ignored.
- UI: a "Policies" block in `HudConsole.tsx` under the existing switches
  (smart meters, demand response, market trading, insulation). One row
  per policy: switch (`data-testid="policy-<id>"`), title, one-line
  body naming effect, cost per day and happiness. Budget panel shows
  the `policies` line. The tile inspector's rooftop figures use
  `rooftopPeakAt`, so a mandated density-1 building shows its PV.
- i18n keys: `policies.title`, `policy.<id>.title`, `policy.<id>.body`,
  `budget.policies`, EN and DE.
- Agent: `set_policy { id, active }` (consequential, validated against
  `POLICY_IDS`); `get_game_overview` gains `policies` (active, dailyCost,
  happiness); `get_build_catalog` lists each policy with its cost,
  happiness and effect parameters. `docs/agent-tools.md` updated.
- Scenarios: unchanged; policies are available in every scenario.

## 3. Tests, balancing, docs

- `src/sim/policies.test.ts`: daily cost charged per tick and reported
  in the budget; happiness term per policy, mandate term zero at full
  coverage; PV bit set only on spawns while active, density-1 building
  with the bit yields `mandatePeakDensity1`, subsidy booked once per
  spawn, bit cleared on bulldoze; night tariff blocks a non-smart home
  charge at noon, allows it at 23:00 and below the floor, leaves smart
  cars alone; speed limit scales car speed and drain, bus speed
  unchanged; mandate doubles installs and halves the city share; save
  round trip with and without the new fields; determinism (same seed and
  policy script → same state hash).
- Existing tests keep passing: every accessor returns the `BALANCE`
  value while its policy is off.
- Headless probe (temporary, deleted before commit): a grown 48×48 city,
  each policy on and off for 20 in-game days; compare evening charging
  peak, import cost, happiness and treasury. Tune `dailyCost`,
  `happiness` and the effect factors from it; record figures in the
  `BALANCE.policies` comments and in `docs/idea.md`.
- Docs: `docs/idea.md` moves "Policies / ordinances" to the done list
  (noting the dropped combustion ban and why); `docs/plan.md` adds a
  line.
- e2e: switch one policy on in the console, assert the budget line
  appears and the switch is still on after a reload.

## Out of scope

Approval mechanics, transition periods, per-district policies, a
combustion-car ban (fleet is electric), tariff effects on tax income.
