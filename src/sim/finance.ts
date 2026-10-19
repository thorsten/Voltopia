import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import {
  CREDIT_KINDS,
  PlantType,
  RATINGS,
  Terrain,
  type Credit,
  type CreditKind,
  type FinanceSave,
  type Rating,
} from '../shared/types.ts';
import { fellingCost } from './forest.ts';
import type { BuildResult } from './roads.ts';
import { daysPerYear } from './seasons.ts';
import { meteredCoverage } from './smartMeters.ts';
import { slopeCostMultiplier, type SimState } from './state.ts';

export { CREDIT_KINDS, RATINGS, type Credit, type CreditKind, type Rating };

/** Below this a credit counts as paid off (float residue of the equal shares). */
const PAID_OFF = 1e-9;

export function defaultFinance(): SimState['finance'] {
  return {
    credits: [],
    nextCreditId: 1,
    gridFee: 0,
    grantUsedThisYear: 0,
    // Years count from 1 (seasons.ts).
    grantYear: 1,
    rating: 'A',
    incomeWindow: [],
    overdraftDays: 0,
    dayIncome: 0,
  };
}

/** A yearly rate applied once per tick. */
function perTick(ratePerYear: number): number {
  return ratePerYear / (daysPerYear() * TICKS_PER_DAY);
}

export function totalDebt(state: SimState): number {
  let total = 0;
  for (const credit of state.finance.credits) total += credit.outstanding;
  return total;
}

/** Mean daily operating income over the rating window; 0 before the first day ends. */
export function averageDailyIncome(state: SimState): number {
  const window = state.finance.incomeWindow;
  if (window.length === 0) return 0;
  let sum = 0;
  for (const income of window) sum += income;
  return sum / window.length;
}

/** Income the debt is measured against: never below the floor, so a new city can borrow. */
function incomeBase(state: SimState): number {
  return Math.max(averageDailyIncome(state), BALANCE.finance.credit.minIncomeBase);
}

/** Highest total debt the lenders accept. */
export function debtCap(state: SimState): number {
  return BALANCE.finance.credit.debtCapDays * incomeBase(state);
}

/** Rate a new credit of `kind` would carry today; null when the rating refuses credit. */
export function creditRate(state: SimState, kind: CreditKind): number | null {
  const rating = state.finance.rating;
  if (rating === 'D') return null;
  return BALANCE.finance.credit[kind].ratePerYear + BALANCE.finance.rating.spread[rating];
}

/** Why a new credit of `kind` and `amount` would be refused; null when it is on offer. */
export function creditOfferRejection(
  state: SimState,
  kind: CreditKind,
  amount: number,
): string | null {
  const { credit } = BALANCE.finance;
  if (creditRate(state, kind) === null) return 'creditRefused';
  if (!(credit[kind].amounts as readonly number[]).includes(amount)) return 'invalidAmount';
  if (state.finance.credits.length >= credit.maxCredits) return 'creditLimit';
  if (totalDebt(state) + amount > debtCap(state)) return 'creditLimit';
  return null;
}

/** Borrow `amount`: the money lands at once, the rate is fixed from now on. Not undoable. */
export function takeCredit(state: SimState, kind: CreditKind, amount: number): BuildResult {
  const rejected = creditOfferRejection(state, kind, amount);
  if (rejected) return { rejected };
  const ratePerYear = creditRate(state, kind) ?? 0;
  state.finance.credits.push({
    id: state.finance.nextCreditId++,
    kind,
    principal: amount,
    outstanding: amount,
    ratePerYear,
    startTick: state.tick,
    termTicks: BALANCE.finance.credit[kind].termDays * TICKS_PER_DAY,
  });
  state.money += amount;
  state.statsDirty = true;
  return {};
}

/** Pay off a loan early, without fee. Bonds run to maturity. */
export function repayCredit(state: SimState, id: number): BuildResult {
  const index = state.finance.credits.findIndex((credit) => credit.id === id);
  if (index < 0) return { rejected: 'unknownCredit' };
  const credit = state.finance.credits[index];
  if (!BALANCE.finance.credit[credit.kind].repayable) return { rejected: 'notRepayable' };
  if (state.money < credit.outstanding) return { rejected: 'notEnoughMoney' };
  state.money -= credit.outstanding;
  state.finance.credits.splice(index, 1);
  state.statsDirty = true;
  return {};
}

/**
 * Rating from debt in days of income and the run of days that ended in
 * the red: the best grade whose thresholds both hold, D otherwise.
 */
export function computeRating(state: SimState): Rating {
  const { maxDebtRatio, maxOverdraftDays } = BALANCE.finance.rating;
  const debtRatio = totalDebt(state) / incomeBase(state);
  const overdraftDays = state.finance.overdraftDays;
  for (const rating of ['A', 'B', 'C'] as const) {
    if (debtRatio <= maxDebtRatio[rating] && overdraftDays <= maxOverdraftDays[rating]) {
      return rating;
    }
  }
  return 'D';
}

/** Start a fresh grant pot when the in-game year has moved on. */
export function rollGrantYear(state: SimState): void {
  const { finance } = state;
  if (finance.grantYear === state.season.year) return;
  finance.grantYear = state.season.year;
  finance.grantUsedThisYear = 0;
}

/** Grant money left in this year's pot. */
export function grantRemaining(state: SimState): number {
  rollGrantYear(state);
  return Math.max(0, BALANCE.finance.grant.annualPot - state.finance.grantUsedThisYear);
}

/**
 * What a plant on `tile` costs: the gross build price (slope or offshore
 * multiplier, plus felling the woods), the grant the pot pays towards it
 * (never towards felling) and the net the treasury pays.
 */
export function plantPrice(
  state: SimState,
  tile: number,
  plant: PlantType,
): { gross: number; grant: number; net: number } {
  // A tidal plant can only ever stand on a sea tile, so — unlike a wind
  // turbine — it has no "choice" of going offshore: its marine cost is
  // already priced into the base cost, so it is exempt from the offshore
  // surcharge (and from the slope multiplier, since a sea tile has no
  // buildable slope of its own).
  const isTidal = plant === PlantType.TidalPlant;
  const offshore = !isTidal && state.layers.terrain[tile] === Terrain.Sea;
  const costMultiplier = isTidal
    ? 1
    : offshore
      ? BALANCE.sea.offshoreCostFactor
      : slopeCostMultiplier(state, tile);
  const base = BALANCE.costs.plant[plant] * costMultiplier;
  const gross = Math.round(base) + fellingCost(state, tile);
  const share = BALANCE.finance.grant.shareByPlant[plant] ?? 0;
  const grant = share > 0 ? Math.min(Math.round(base * share), grantRemaining(state)) : 0;
  return { gross, grant, net: gross - grant };
}

/**
 * Grid-fee income this tick: the fee on every unit the buildings drew
 * last tick — their base load plus electric heating and cooling, which
 * the energy balance books as separate lines, so each unit is billed
 * once. Charging and traction are not billed. Smart-metered buildings
 * pay the discounted fee.
 */
export function gridFeeIncome(state: SimState): number {
  const fee = state.finance.gridFee;
  if (fee <= 0) return 0;
  const { buildingConsumption, heatingConsumption, coolingConsumption } = state.lastEnergy;
  const billed = buildingConsumption + heatingConsumption + coolingConsumption;
  const discount = meteredCoverage(state) * BALANCE.finance.gridFee.smartMeterDiscount;
  return fee * billed * (1 - discount);
}

/** Set the grid fee, clamped to 0..maxRate and snapped to the slider step. */
export function setGridFee(state: SimState, rate: number): void {
  if (!Number.isFinite(rate)) return;
  const { maxRate, step } = BALANCE.finance.gridFee;
  const clamped = Math.min(maxRate, Math.max(0, rate));
  // Dividing by the steps per unit (not multiplying by the step) keeps
  // the snapped value free of float residue such as 0.009000000000000001.
  state.finance.gridFee = Math.round(clamped / step) / Math.round(1 / step);
  state.statsDirty = true;
}

/** Happiness term of the grid fee: any fee costs, linearly (neutral rate 0). */
export function gridFeeHappiness(state: SimState): number {
  const fee = state.finance.gridFee;
  return fee > 0 ? -fee * BALANCE.finance.gridFee.happinessWeight : 0;
}

/**
 * Book this tick's grid-fee income, debt service and overdraft interest. Runs after the
 * day's operating income has landed (after repairStep); `operatingNet`
 * is that income, which feeds the rating at each day rollover. Debt
 * service is never skipped: it may drive money negative, and a negative
 * treasury then pays overdraft interest.
 */
export function financeStep(state: SimState, operatingNet: number): void {
  const { finance } = state;
  const feeIncome = finance.gridFee > 0 ? gridFeeIncome(state) : 0;
  state.money += feeIncome;

  let interest = 0;
  let principal = 0;
  if (finance.credits.length > 0) {
    for (const credit of finance.credits) {
      const due = credit.outstanding * perTick(credit.ratePerYear);
      const matured = state.tick - credit.startTick >= credit.termTicks;
      // Loans pay an equal principal share each tick, bonds all at maturity.
      let repaid = 0;
      if (matured) repaid = credit.outstanding;
      else if (credit.kind === 'loan') {
        repaid = Math.min(credit.outstanding, credit.principal / credit.termTicks);
      }
      credit.outstanding -= repaid;
      interest += due;
      principal += repaid;
    }
    finance.credits = finance.credits.filter((credit) => credit.outstanding > PAID_OFF);
    state.money -= interest + principal;
  }

  let overdraftInterest = 0;
  if (state.money < 0) {
    overdraftInterest = -state.money * perTick(BALANCE.finance.overdraftRatePerYear);
    state.money -= overdraftInterest;
  }

  finance.dayIncome += operatingNet + feeIncome;
  if (state.tick % TICKS_PER_DAY === 0) {
    rollGrantYear(state);
    finance.incomeWindow.push(finance.dayIncome);
    const excess = finance.incomeWindow.length - BALANCE.finance.rating.windowDays;
    if (excess > 0) finance.incomeWindow.splice(0, excess);
    finance.dayIncome = 0;
    finance.overdraftDays = state.money < 0 ? finance.overdraftDays + 1 : 0;
    finance.rating = computeRating(state);
    state.statsDirty = true;
  }

  state.lastFinance = { interest, principal, overdraftInterest, gridFeeIncome: feeIncome };
  if (interest > 0 || principal > 0 || overdraftInterest > 0 || feeIncome > 0) {
    state.statsDirty = true;
  }
}

/** The persisted part of the finance record. */
export function saveFinance(state: SimState): FinanceSave {
  const { finance } = state;
  return {
    credits: finance.credits.map((credit) => ({ ...credit })),
    nextCreditId: finance.nextCreditId,
    gridFee: finance.gridFee,
    grantUsedThisYear: finance.grantUsedThisYear,
    grantYear: finance.grantYear,
    rating: finance.rating,
    incomeWindow: [...finance.incomeWindow],
    overdraftDays: finance.overdraftDays,
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitiseCredit(value: unknown): Credit | null {
  if (typeof value !== 'object' || value === null) return null;
  const c = value as Partial<Record<keyof Credit, unknown>>;
  if (!CREDIT_KINDS.includes(c.kind as CreditKind)) return null;
  if (!finite(c.id) || !Number.isInteger(c.id)) return null;
  if (!finite(c.principal) || !finite(c.outstanding) || !finite(c.ratePerYear)) return null;
  if (!finite(c.startTick) || !finite(c.termTicks) || c.termTicks <= 0) return null;
  if (c.outstanding <= PAID_OFF || c.principal <= 0 || c.ratePerYear < 0) return null;
  return {
    id: c.id,
    kind: c.kind as CreditKind,
    principal: c.principal,
    outstanding: c.outstanding,
    ratePerYear: c.ratePerYear,
    startTick: c.startTick,
    termTicks: c.termTicks,
  };
}

/** Finance record from a save: absent means a debt-free city at A; garbage is dropped or clamped. */
export function loadFinance(save: FinanceSave | undefined): SimState['finance'] {
  const finance = defaultFinance();
  if (!save || typeof save !== 'object') return finance;
  const credits = Array.isArray(save.credits) ? save.credits : [];
  for (const raw of credits) {
    const credit = sanitiseCredit(raw);
    if (credit) finance.credits.push(credit);
  }
  const maxId = finance.credits.reduce((max, credit) => Math.max(max, credit.id), 0);
  const nextId = finite(save.nextCreditId) ? Math.floor(save.nextCreditId) : 1;
  finance.nextCreditId = Math.max(nextId, maxId + 1);
  if (finite(save.gridFee)) {
    finance.gridFee = Math.min(BALANCE.finance.gridFee.maxRate, Math.max(0, save.gridFee));
  }
  if (finite(save.grantUsedThisYear)) {
    finance.grantUsedThisYear = Math.max(0, save.grantUsedThisYear);
  }
  if (finite(save.grantYear)) finance.grantYear = Math.floor(save.grantYear);
  if (RATINGS.includes(save.rating)) finance.rating = save.rating;
  const window = Array.isArray(save.incomeWindow) ? save.incomeWindow.filter(finite) : [];
  finance.incomeWindow = window.slice(-BALANCE.finance.rating.windowDays);
  if (finite(save.overdraftDays))
    finance.overdraftDays = Math.max(0, Math.floor(save.overdraftDays));
  return finance;
}
