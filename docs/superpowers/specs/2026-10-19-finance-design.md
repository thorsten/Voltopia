# Finance — design

Date: 2026-10-19. Status: approved in conversation, awaiting spec review.

## Purpose

Today the tax slider is the only money lever, and a negative treasury
has no consequence. Finance adds three levers and makes debt real:

1. **Credit**: loans (amortising, repayable early) and bonds (bigger,
   cheaper, interest-only, principal due at maturity).
2. **Overdraft interest and a credit rating**: a negative treasury costs
   interest; a rating A–D from debt and overdraft sets the rates of new
   credit and blocks it at D.
3. **Renewable investment grant**: a share of the build price of
   renewables and storage is refunded from an annual grant pot.
4. **Grid fee**: a second slider beside the tax, charged per unit of
   energy buildings consume; smart-metered buildings pay less.

## Decisions

- One module `src/sim/finance.ts`, one `BALANCE.finance` block, one
  `SimState.finance` record. Everything inactive (no credit, money ≥ 0,
  grid fee 0) yields exactly today's numbers, so existing tests stay
  valid. The grant is the exception: it lowers build prices from day
  one, which is intended; tests that assert exact plant prices read
  them through `plantPrice()` or pin the pot to 0.
- Time unit: an in-game year is 20 days (`seasonsPerYear ×
daysPerSeason`). Rates are configured per year and applied per tick
  (`rate / (20 × TICKS_PER_DAY)`), simple interest on the outstanding
  amount — no compounding within a tick.
- Rates are fixed when credit is taken; the rating only affects new
  credit.
- No bankruptcy or game over. Deep debt shows up as overdraft interest,
  a D rating and no new credit; the city can always recover through
  tax and the grid fee.
- Scenario `money` metric becomes **net worth** (`money − debt`), so
  borrowing cannot fake a money goal. The HUD keeps showing cash.

## 1. Credit

```ts
type CreditKind = 'loan' | 'bond';
interface Credit {
  id: number;              // monotonically increasing, from finance.nextCreditId
  kind: CreditKind;
  principal: number;       // amount borrowed
  outstanding: number;     // principal still owed
  ratePerYear: number;     // fixed at origination
  startTick: number;
  termTicks: number;
}
SimState.finance: {
  credits: Credit[];
  nextCreditId: number;
  gridFee: number;                  // money per EU, 0..BALANCE.finance.gridFee.maxRate
  grantUsedThisYear: number;        // pot spent in the current in-game year
  grantYear: number;                // year the counter belongs to
  rating: Rating;                   // 'A' | 'B' | 'C' | 'D', recomputed daily
  incomeWindow: number[];           // trailing daily operating income, ≤ ratingWindowDays entries
  dayIncome: number;                // accumulator for the current day
  overdraftDays: number;            // consecutive days that ended below 0
};
```

`BALANCE.finance.credit`:

| product | amounts               | term    | base rate/yr | repayment                                                                 |
| ------- | --------------------- | ------- | ------------ | ------------------------------------------------------------------------- |
| loan    | 5_000, 10_000, 20_000 | 10 days | 0.08         | equal principal share per tick plus interest; repayable early without fee |
| bond    | 50_000, 100_000       | 40 days | 0.05         | interest per tick only; full principal at maturity; no early repayment    |

Rating spread added to the base rate: A +0, B +0.02, C +0.05, D — no
new credit. At most `maxCredits` (4) open at once.

Per tick (`financeStep`, after `policiesStep`):

- Loans: pay `principal / termTicks` (capped at outstanding) plus
  `outstanding × ratePerTick`. Bonds: pay `outstanding × ratePerTick`;
  on the maturity tick pay the full outstanding. Payments are taken even
  if money goes negative — debt service is never skipped. A credit at
  outstanding 0 is removed.
- Overdraft: if `money < 0`, charge `−money × overdraftRatePerYear`
  per tick (0.25/yr).
- Book `lastFinance = { interest, principal, overdraftInterest, gridFeeIncome, grant }`
  for the budget panel.
- Skip the credit loop entirely when there are no credits and money ≥ 0
  (CI budget).

Commands (no undo):

- `{ type: 'takeCredit'; kind: CreditKind; amount: number }` — rejected
  with `creditRefused` at rating D, `creditLimit` if `maxCredits` open or
  the new debt would exceed the debt cap, `invalidAmount` if not a
  listed amount. On success money += amount.
- `{ type: 'repayCredit'; id: number }` — loans only; rejected with
  `notRepayable` for bonds, `notEnoughMoney` if money < outstanding.

Debt cap: total outstanding after the new credit ≤
`debtCapDays × max(averageDailyIncome, minIncomeBase)`; `debtCapDays`
30, `minIncomeBase` 1_000 so a new city can still borrow 30_000.
`averageDailyIncome` is the mean over the full rating window with days
not yet played counted as 0 (changed in the balance probe), so one good
first day cannot open the bond market.

## 2. Rating

Recomputed once per day at day rollover from the trailing
`ratingWindowDays` (5) of daily operating income (tax + grid fee +
export + hydrogen − all upkeep and running costs, excluding credit
flows):

```
debtRatio = debt / max(averageDailyIncome, minIncomeBase)    // in days of income
A: debtRatio ≤ 10 and overdraftDays = 0
B: debtRatio ≤ 20 and overdraftDays ≤ 1
C: debtRatio ≤ 30 and overdraftDays ≤ 3
D: otherwise
```

A new city starts at A. Thresholds live in `BALANCE.finance.rating`.

## 3. Renewable investment grant

`BALANCE.finance.grant`: `shareByPlant` (solar, wind, run-of-river,
tidal, geothermal 0.3; battery, pumped storage 0.2; everything else 0 —
biogas burns fuel and is excluded), `annualPot` 15_000 (tuned by probe).

`plantPrice(state, tile, plant): { gross, grant, net }` — gross is
today's cost (slope/offshore multiplier plus felling), grant is
`min(gross_without_felling × share, annualPot − grantUsedThisYear)`,
net = gross − grant. `placePlant` charges `net`, adds `grant` to
`grantUsedThisYear`, and records `grantDelta` on the `UndoEntry`
(optional field); undo refunds `net` and gives the grant back to the
pot. The pot resets when the in-game year changes. Bulldozing is
unchanged (no refund, no pot change).

Build bar and tile tooltip show the net price with the gross struck
through while the pot covers it; `GlobalStats.finance.grantRemaining`
drives the display.

## 4. Grid fee

`BALANCE.finance.gridFee`: `maxRate` 0.02, `step` 0.001,
`smartMeterDiscount` 0.5, `happinessWeight` (tuned by probe; neutral
rate 0, so any fee costs happiness, linear like the tax penalty).

```
billed = buildingConsumption + heatingConsumption + coolingConsumption
meteredShare = smartMeters.metered / buildings
gridFeeIncome = gridFee × billed × (1 − meteredShare × smartMeterDiscount)
```

Added to `state.money` in `financeStep`. `happinessStep` adds
`−gridFee × happinessWeight`. Command `{ type: 'setGridFee'; rate }`,
clamped and snapped to `step`. Default 0.

## 5. Protocol, UI, agent

- `GlobalStats.finance: { credits: CreditView[]; debt; rating; gridFee; grantRemaining; grantPot; debtCap; offers: CreditOffer[] }`
  where `CreditOffer = { kind; amounts; ratePerYear; termDays; available: boolean; reason? }`.
- `BudgetStats` gains `gridFees`, `interest` (credit interest +
  overdraft interest) and `repayment` (principal); `grant` is not a
  budget line (it lowers the build price). Net = operating income −
  interest; repayment shown below the net as cash flow.
- `SaveGame.finance?` (credits, nextCreditId, gridFee,
  grantUsedThisYear, grantYear, rating, incomeWindow, overdraftDays),
  optional, `SAVE_VERSION` unchanged; absent means a debt-free city at A.
- UI:
  - Grid-fee slider in `HudConsole.tsx` under the tax slider
    (`GridFeeSlider`, `data-testid="grid-fee-slider"`), showing the
    happiness cost.
  - Finance section in `BudgetPanel.tsx`: rating badge, debt / cap,
    open credits (remaining, rate, days left, repay button for loans),
    offers as buttons (`data-testid="credit-<kind>-<amount>"`), grant
    pot remaining.
  - Budget lines `budget.gridFees`, `budget.interest`, `budget.repayment`.
  - i18n EN + DE for all keys (`finance.*`, `credit.*`, `rating.*`,
    `gridFee.*`, rejection reasons).
- Agent tools: `take_credit { kind, amount }`, `repay_credit { id }`,
  `set_grid_fee { rate }` (consequential); `get_game_overview` gains
  `finance`; `get_build_catalog` lists credit products, grant shares,
  pot and grid-fee range; plant placement results report `grant`.
  `docs/agent-tools.md` updated.

## 6. Tests, balancing, docs

- `src/sim/finance.test.ts`: loan amortises to 0 in `termTicks` with the
  expected interest total; early repayment; bond pays interest only and
  the principal at maturity, cannot be repaid early; payments drive money
  negative rather than skip; overdraft interest; rating thresholds and
  the D refusal; debt cap with `minIncomeBase`; grant share, pot cap,
  pot reset at year change, undo restores pot and money; grid fee
  income with and without meters, clamping/snapping, happiness term;
  save round trip with and without `finance`; determinism hash.
- Scenario test: net-worth metric ignores borrowed cash.
- Headless probe (temporary): a grown 48×48 city over one seed-year,
  variants (a) baseline, (b) bond-financed early wind build-out, (c)
  grid fee at several rates with/without smart meters, (d) grant pot
  sizes. Tune rates, pot, `happinessWeight` so that borrowing to build
  renewables pays off over a year when the money goes into generation
  that cuts import, but not when it is burnt on upkeep; and so that a
  grid fee raising the same money as a tax increase costs about the
  same happiness. Record figures in `BALANCE.finance` comments and
  `docs/idea.md`.
- e2e: take a loan in the budget panel, see debt and rating, reload,
  the credit is still there; move the grid-fee slider.
- Docs: `docs/idea.md` marks Finance done; `docs/plan.md` adds a line;
  README feature list.

## Out of scope

Variable rates, refinancing, defaults/bankruptcy, per-district fees,
time-of-day tariffs on the grid fee, feed-in premiums, neighbouring
cities as lenders.
