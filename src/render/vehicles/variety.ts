export type CarStyle = 'hatchback' | 'sedan' | 'estate' | 'suv';
export const CAR_STYLES: readonly CarStyle[] = ['hatchback', 'sedan', 'estate', 'suv'];
export type FreightBody = 'container' | 'hopper' | 'tank';
export const FREIGHT_BODIES: readonly FreightBody[] = ['container', 'hopper', 'tank'];

/** Paints, muted to sit with the city palette: whites, greys, blues, a red, a green, a sand. */
export const CAR_COLORS: readonly number[] = [
  0xe8e6e0, 0xc9ccd1, 0x707a86, 0x3a4048, 0x8fb3c9, 0x3f6f9e, 0xc9584a, 0x9aa88f, 0xd9a066,
  0xc9788f,
];
export const CONTAINER_COLORS: readonly number[] = [0xc9584a, 0x3f6f9e, 0x5f8f5a, 0xd9a441];

/**
 * Deterministic 32-bit integer hash (a murmur3 finaliser). Works on ids
 * above 2^32 (wagon ids are train id + k · 2^30) by folding the high part.
 */
export function vehicleHash(id: number): number {
  let h = (id >>> 0) ^ Math.floor(id / 4294967296);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Different bits for each choice, so style and paint are independent.
 * Hashed twice: `id ^ salt` on ids above 2^31 (wagon ids run past that)
 * loses the high part when folded through `>>> 0`, so the salt is mixed
 * in after the first hash rather than into the raw id.
 */
const pick = <T>(list: readonly T[], id: number, salt: number): T =>
  list[vehicleHash(vehicleHash(id) ^ salt) % list.length];

export const carStyleOf = (id: number): CarStyle => pick(CAR_STYLES, id, 0x51);
export const carColorOf = (id: number): number => pick(CAR_COLORS, id, 0xa3);
export const freightBodyOf = (id: number): FreightBody => pick(FREIGHT_BODIES, id, 0x5c);
export const containerColorOf = (id: number): number => pick(CONTAINER_COLORS, id, 0x2e);
