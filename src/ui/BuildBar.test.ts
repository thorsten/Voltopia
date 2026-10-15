import { describe, expect, it } from 'vitest';
import { CATEGORIES } from './BuildBar.tsx';
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
