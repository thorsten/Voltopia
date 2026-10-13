/**
 * Deterministic pseudo-random value 0..1 from a tile index and a salt, so
 * trees, bushes and rocks keep their spots across rebuilds (and match on
 * reload).
 */
export function tileHash(index: number, salt: number): number {
  let h = (index * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 13;
  h = (h * 0x5bd1e995) >>> 0;
  return (h >>> 8) / 16777216;
}
