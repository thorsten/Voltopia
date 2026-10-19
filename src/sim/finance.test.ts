import { describe, expect, it } from 'vitest';
import { BALANCE, TICKS_PER_DAY } from '../shared/constants.ts';
import type { FinanceSave } from '../shared/types.ts';
import {
  averageDailyIncome,
  computeRating,
  creditRate,
  debtCap,
  defaultFinance,
  financeStep,
  repayCredit,
  takeCredit,
  totalDebt,
} from './finance.ts';
import { daysPerYear } from './seasons.ts';
import { createSimState, deserializeState, serializeState, type SimState } from './state.ts';
import { buildStats } from './tick.ts';

const SIZE = 32;
const { credit, rating } = BALANCE.finance;

/** Advance the clock and run the finance step `ticks` times; returns the summed interest. */
function run(state: SimState, ticks: number, operatingNet = 0): number {
  let interest = 0;
  for (let i = 0; i < ticks; i++) {
    state.tick++;
    financeStep(state, operatingNet);
    interest += state.lastFinance.interest;
  }
  return interest;
}

describe('credit', () => {
  it('a loan amortises to 0 over its term with about half the simple interest', () => {
    const state = createSimState(1, SIZE, 1e6);
    expect(takeCredit(state, 'loan', 10_000)).toEqual({});
    expect(state.money).toBe(1e6 + 10_000);
    const [loan] = state.finance.credits;
    expect(loan.termTicks).toBe(credit.loan.termDays * TICKS_PER_DAY);
    const interest = run(state, loan.termTicks - 1);
    expect(state.finance.credits).toHaveLength(1);
    run(state, 1);
    expect(state.finance.credits).toHaveLength(0);
    expect(totalDebt(state)).toBe(0);
    const expected = (10_000 * credit.loan.ratePerYear * credit.loan.termDays) / daysPerYear() / 2;
    expect(Math.abs(interest + state.lastFinance.interest - expected) / expected).toBeLessThan(
      0.01,
    );
  });

  it('a loan may be repaid early, but not without the money', () => {
    const state = createSimState(1, SIZE, 0);
    takeCredit(state, 'loan', 5_000);
    const id = state.finance.credits[0].id;
    state.money = 100;
    expect(repayCredit(state, id)).toEqual({ rejected: 'notEnoughMoney' });
    state.money = 6_000;
    expect(repayCredit(state, id)).toEqual({});
    expect(state.money).toBe(1_000);
    expect(state.finance.credits).toHaveLength(0);
    expect(repayCredit(state, id)).toEqual({ rejected: 'unknownCredit' });
  });

  it('a bond pays interest only and the principal at maturity; no early repayment', () => {
    const state = createSimState(1, SIZE, 1e6);
    // A bond needs more than a new city's capped borrowing.
    state.finance.incomeWindow = [1e6];
    expect(takeCredit(state, 'bond', 50_000)).toEqual({});
    const bond = state.finance.credits[0];
    expect(repayCredit(state, bond.id)).toEqual({ rejected: 'notRepayable' });
    const perTick = (credit.bond.ratePerYear * 50_000) / (daysPerYear() * TICKS_PER_DAY);
    run(state, bond.termTicks - 1);
    expect(bond.outstanding).toBe(50_000);
    expect(state.lastFinance.interest).toBeCloseTo(perTick, 9);
    expect(state.lastFinance.principal).toBe(0);
    const before = state.money;
    run(state, 1);
    expect(state.lastFinance.principal).toBe(50_000);
    expect(state.money).toBeCloseTo(before - 50_000 - perTick, 6);
    expect(state.finance.credits).toHaveLength(0);
  });

  it('debt service is never skipped: money goes negative and overdraft interest applies', () => {
    const state = createSimState(1, SIZE, 0);
    takeCredit(state, 'loan', 5_000);
    state.money = 0;
    run(state, 1);
    expect(state.money).toBeLessThan(0);
    expect(state.lastFinance.principal).toBeGreaterThan(0);
    run(state, 1);
    const overdraft = state.lastFinance.overdraftInterest;
    expect(overdraft).toBeGreaterThan(0);
    const budget = buildStats(state).budget;
    expect(budget.interest).toBeCloseTo(state.lastFinance.interest + overdraft, 9);
    expect(budget.repayment).toBeCloseTo(state.lastFinance.principal, 9);
    expect(budget.net).toBeCloseTo(-budget.interest, 9);
  });

  it('overdraft interest follows the yearly rate without any credit', () => {
    const state = createSimState(1, SIZE, -1_000);
    run(state, 1);
    const expected =
      (1_000 * BALANCE.finance.overdraftRatePerYear) / (daysPerYear() * TICKS_PER_DAY);
    expect(state.lastFinance.overdraftInterest).toBeCloseTo(expected, 9);
    expect(state.money).toBeCloseTo(-1_000 - expected, 9);
  });
});

describe('rating', () => {
  it('debt ratio and overdraft days map onto A to D', () => {
    const state = createSimState(1, SIZE, 0);
    state.finance.incomeWindow = [2_000, 2_000];
    const credits = (debt: number): void => {
      state.finance.credits = [
        {
          id: 1,
          kind: 'bond',
          principal: debt,
          outstanding: debt,
          ratePerYear: 0.05,
          startTick: 0,
          termTicks: 1_000,
        },
      ];
    };
    credits(rating.maxDebtRatio.A * 2_000);
    expect(computeRating(state)).toBe('A');
    state.finance.overdraftDays = 1;
    expect(computeRating(state)).toBe('B');
    credits(rating.maxDebtRatio.B * 2_000);
    state.finance.overdraftDays = 0;
    expect(computeRating(state)).toBe('B');
    credits(rating.maxDebtRatio.C * 2_000);
    expect(computeRating(state)).toBe('C');
    state.finance.overdraftDays = rating.maxOverdraftDays.C + 1;
    expect(computeRating(state)).toBe('D');
    state.finance.overdraftDays = 0;
    credits(rating.maxDebtRatio.C * 2_000 + 1);
    expect(computeRating(state)).toBe('D');
    // A poor city is measured against the income floor.
    state.finance.incomeWindow = [-500];
    credits(rating.maxDebtRatio.A * credit.minIncomeBase);
    expect(computeRating(state)).toBe('A');
  });

  it('D refuses new credit; B adds its spread to the base rate', () => {
    const state = createSimState(1, SIZE, 0);
    state.finance.rating = 'D';
    expect(creditRate(state, 'loan')).toBeNull();
    expect(takeCredit(state, 'loan', 5_000)).toEqual({ rejected: 'creditRefused' });
    state.finance.rating = 'B';
    expect(takeCredit(state, 'loan', 5_000)).toEqual({});
    expect(state.finance.credits[0].ratePerYear).toBeCloseTo(
      credit.loan.ratePerYear + rating.spread.B,
      9,
    );
  });

  it('the day rollover pushes the day income into a capped window and rerates', () => {
    const state = createSimState(1, SIZE, 0);
    for (let day = 0; day < rating.windowDays + 2; day++) run(state, TICKS_PER_DAY, day + 1);
    expect(state.finance.incomeWindow).toHaveLength(rating.windowDays);
    expect(state.finance.incomeWindow[0]).toBeCloseTo(3 * TICKS_PER_DAY, 6);
    expect(state.finance.incomeWindow.at(-1)).toBeCloseTo(
      (rating.windowDays + 2) * TICKS_PER_DAY,
      6,
    );
    expect(state.finance.dayIncome).toBe(0);
    expect(averageDailyIncome(state)).toBeCloseTo(5 * TICKS_PER_DAY, 6);
    // A day that ends in the red counts; two of them cost the A.
    state.money = -1;
    run(state, TICKS_PER_DAY * 2);
    expect(state.finance.overdraftDays).toBe(2);
    expect(state.finance.rating).toBe('C');
  });
});

describe('debt cap', () => {
  it('a new city borrows up to the floor cap, four credits at most, listed amounts only', () => {
    const state = createSimState(1, SIZE, 0);
    expect(averageDailyIncome(state)).toBe(0);
    expect(debtCap(state)).toBe(credit.debtCapDays * credit.minIncomeBase);
    expect(takeCredit(state, 'loan', 7_000)).toEqual({ rejected: 'invalidAmount' });
    expect(takeCredit(state, 'loan', 20_000)).toEqual({});
    expect(takeCredit(state, 'loan', 10_000)).toEqual({});
    expect(totalDebt(state)).toBe(30_000);
    expect(takeCredit(state, 'loan', 5_000)).toEqual({ rejected: 'creditLimit' });

    const rich = createSimState(1, SIZE, 0);
    rich.finance.incomeWindow = [1e6];
    for (let i = 0; i < credit.maxCredits; i++) {
      expect(takeCredit(rich, 'loan', 5_000)).toEqual({});
    }
    expect(takeCredit(rich, 'loan', 5_000)).toEqual({ rejected: 'creditLimit' });
    expect(rich.finance.credits.map((c) => c.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('finance state', () => {
  it('an inactive finance step leaves money alone and books nothing', () => {
    const state = createSimState(1, SIZE, 500);
    run(state, 3, 10);
    expect(state.money).toBe(500);
    expect(state.lastFinance).toEqual({
      interest: 0,
      principal: 0,
      overdraftInterest: 0,
      gridFeeIncome: 0,
    });
    const budget = buildStats(state).budget;
    expect(budget.gridFees).toBe(0);
    expect(budget.interest).toBe(0);
    expect(budget.repayment).toBe(0);
  });

  it('survives a save round trip; a save without finance is debt-free at A', () => {
    const state = createSimState(1, SIZE, 0);
    state.finance.incomeWindow = [1e6];
    expect(takeCredit(state, 'loan', 10_000)).toEqual({});
    expect(takeCredit(state, 'bond', 50_000)).toEqual({});
    state.finance.incomeWindow = [1, 2, 3];
    state.finance.overdraftDays = 2;
    state.finance.rating = 'C';
    run(state, 10);
    const save = serializeState(state);
    const loaded = deserializeState(save);
    expect(loaded.finance.credits).toEqual(state.finance.credits);
    expect(loaded.finance.nextCreditId).toBe(3);
    expect(loaded.finance.incomeWindow).toEqual([1, 2, 3]);
    expect(loaded.finance.overdraftDays).toBe(2);
    expect(loaded.finance.rating).toBe('C');

    delete save.finance;
    expect(deserializeState(save).finance).toEqual(defaultFinance());
  });

  it('sanitises garbage from a save', () => {
    const save = serializeState(createSimState(1, SIZE, 0));
    save.finance = {
      credits: [
        {
          id: 7,
          kind: 'loan',
          principal: 5_000,
          outstanding: 4_000,
          ratePerYear: 0.08,
          startTick: 0,
          termTicks: 100,
        },
        {
          id: 8,
          kind: 'mortgage',
          principal: 1,
          outstanding: 1,
          ratePerYear: 0,
          startTick: 0,
          termTicks: 1,
        },
        {
          id: 9,
          kind: 'bond',
          principal: NaN,
          outstanding: 1,
          ratePerYear: 0,
          startTick: 0,
          termTicks: 1,
        },
        null,
      ],
      nextCreditId: 2,
      gridFee: 5,
      grantUsedThisYear: -3,
      grantYear: Infinity,
      rating: 'Z',
      incomeWindow: [1, 'x', NaN, 2, 3, 4, 5, 6, 7],
      overdraftDays: -4,
    } as unknown as FinanceSave;
    const { finance } = deserializeState(save);
    expect(finance.credits.map((c) => c.id)).toEqual([7]);
    expect(finance.nextCreditId).toBe(8);
    expect(finance.gridFee).toBe(BALANCE.finance.gridFee.maxRate);
    expect(finance.grantUsedThisYear).toBe(0);
    expect(finance.grantYear).toBe(defaultFinance().grantYear);
    expect(finance.rating).toBe('A');
    expect(finance.incomeWindow).toEqual([3, 4, 5, 6, 7]);
    expect(finance.overdraftDays).toBe(0);
  });
});
