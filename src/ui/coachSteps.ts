import type { GlobalStats } from '../shared/types.ts';
import type { TranslationKey } from './i18n.tsx';

/** One step of a coach-mark sequence (first-run tutorial or a system intro). */
export interface CoachStep {
  id: string;
  title: TranslationKey;
  body: TranslationKey;
  /** Auto-advance when this becomes true (undefined = manual button). */
  isComplete?: (stats: GlobalStats) => boolean;
}
