/** File names for exported saves and names for imported ones (DOM-free). */

/** Slugs stay short enough for any file system and still readable. */
const MAX_SLUG_LENGTH = 48;

/** `"Neue Straße – Tag 3"` → `"neue-strasse-tag-3"`; empty input gives `""`. */
export function slugify(name: string): string {
  return name
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
}

/** `YYYY-MM-DD` of a date (UTC, like the current-city export always used). */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Export file name for a named save: `voltopia-<slug>-<YYYY-MM-DD>.json`. */
export function saveFileName(name: string, date: Date): string {
  return `voltopia-${slugify(name) || 'save'}-${isoDay(date)}.json`;
}

/** Export file name for the running city: `voltopia-save-<YYYY-MM-DD>.json`. */
export function currentCityFileName(date: Date): string {
  return `voltopia-save-${isoDay(date)}.json`;
}

/** Save name for an imported file: the file name without `.json` (or `fallback` when empty). */
export function nameFromFileName(fileName: string, fallback: string): string {
  const name = fileName.replace(/\.json$/i, '').trim();
  return name === '' ? fallback : name;
}
