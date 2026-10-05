/** Shortest viewport side below this is a phone: tablets start at 744 px (iPad mini), phones end at ~430 px wide. */
export const SMALL_SCREEN_MAX_SHORT_SIDE = 600;

export function isSmallScreen(width: number, height: number): boolean {
  return Math.min(width, height) < SMALL_SCREEN_MAX_SHORT_SIDE;
}

const DISMISSED_KEY = 'voltopia.smallScreenDismissed';

export function wasSmallScreenNoticeDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberSmallScreenNoticeDismissed(): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // best effort only
  }
}
