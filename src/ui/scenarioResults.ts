/** Best result per scenario, kept in localStorage for the scenarios page. */
export interface ScenarioResult {
  status: 'won' | 'failed';
  day: number;
}

const key = (id: string) => `voltopia.scenario.${id}`;

export function readBestResult(id: string): ScenarioResult | null {
  try {
    const raw = localStorage.getItem(key(id));
    return raw ? (JSON.parse(raw) as ScenarioResult) : null;
  } catch {
    return null;
  }
}

/** A win always beats a loss; among wins the earlier day wins, among losses the later. */
export function recordResult(id: string, status: 'won' | 'failed', day: number): void {
  const best = readBestResult(id);
  const better =
    !best ||
    (status === 'won' && best.status === 'failed') ||
    (status === best.status && status === 'won' && day < best.day) ||
    (status === best.status && status === 'failed' && day > best.day);
  if (!better) return;
  try {
    localStorage.setItem(key(id), JSON.stringify({ status, day }));
  } catch {
    // best effort only
  }
}
