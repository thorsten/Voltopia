import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/constants.ts';
import { PlantType } from '../shared/types.ts';
import { CATEGORIES, grantedPrice } from './BuildBar.tsx';
import { englishText, type TranslationKey } from './i18n.tsx';

describe('build bar tool descriptions', () => {
  it('supplies every {placeholder} of a tool description through descVars', () => {
    for (const category of CATEGORIES) {
      for (const button of category.buttons) {
        const text = englishText(`tool.${button.id}.desc` as TranslationKey);
        const names = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        expect(Object.keys(button.descVars ?? {}), button.id).toEqual(
          expect.arrayContaining(names),
        );
      }
    }
  });
});

describe('granted plant prices', () => {
  it('takes the grant share off renewables, capped by the pot', () => {
    const cost = BALANCE.costs.plant[PlantType.SolarFarm];
    const share = BALANCE.finance.grant.shareByPlant[PlantType.SolarFarm] ?? 0;
    expect(share).toBeGreaterThan(0);
    const full = grantedPrice(cost, PlantType.SolarFarm, 1e9);
    expect(full.grant).toBe(Math.round(cost * share));
    expect(full.net).toBe(cost - full.grant);
    expect(grantedPrice(cost, PlantType.SolarFarm, 10)).toEqual({ net: cost - 10, grant: 10 });
    expect(grantedPrice(cost, PlantType.SolarFarm, 0)).toEqual({ net: cost, grant: 0 });
  });

  it('gives plants without a share and non-plant tools no grant', () => {
    const cost = BALANCE.costs.plant[PlantType.BiogasPlant];
    expect(grantedPrice(cost, PlantType.BiogasPlant, 1e9)).toEqual({ net: cost, grant: 0 });
    expect(grantedPrice(100, undefined, 1e9)).toEqual({ net: 100, grant: 0 });
  });
});
