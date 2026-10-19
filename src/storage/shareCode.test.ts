import { describe, expect, it, vi } from 'vitest';
import { MAP_SIZES, SAVE_VERSION } from '../shared/constants.ts';
import { tileIndex } from '../shared/grid.ts';
import { PlantType, SCENARIO_IDS, type SaveGame, Zone } from '../shared/types.ts';
import { SimEngine } from '../sim/engine.ts';
import { countPopulationAndJobs, deserializeState, serializeState } from '../sim/state.ts';
import '../sim/scenarios/defs/index.ts';
import { scenarioDef } from '../sim/scenarios/registry.ts';
import { fullSave } from '../test/saveFixtures.ts';
import { SAVE_LAYERS, saveFieldsToJson } from './serialization.ts';
import {
  decodeShareCode,
  encodeShareCode,
  fromBase64Url,
  SHARE_FORMAT_VERSION,
  SHARE_INFLATE_SLICE,
  SHARE_MAX_BYTES,
  SHARE_MAX_CODE_LENGTH,
  SHARE_MAX_MAP_SIZE,
  SHARE_MIN_MAP_SIZE,
  ShareCodeError,
  toBase64Url,
} from './shareCode.ts';

const SIZE = MAP_SIZES[0];

/** A small grown city: a road, zones on both sides, a solar farm, a credit and an ordinance. */
function grownCity(): SaveGame {
  const engine = new SimEngine(3, SIZE);
  engine.applyCommand({ type: 'init', seed: 3, size: SIZE, disasterScale: 0 });
  const at = (x: number, y: number) => tileIndex(x, y, SIZE);
  const row = (y: number, from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => at(from + i, y));
  engine.applyCommand({ type: 'buildRoad', tiles: row(10, 2, 30) });
  engine.applyCommand({ type: 'paintZone', tiles: row(9, 4, 28), zone: Zone.Residential });
  engine.applyCommand({ type: 'paintZone', tiles: row(11, 4, 18), zone: Zone.Commercial });
  engine.applyCommand({ type: 'placePlant', tile: at(22, 12), plant: PlantType.SolarFarm });
  engine.applyCommand({ type: 'takeCredit', kind: 'loan', amount: 5_000 });
  engine.applyCommand({ type: 'setPolicy', id: 'speedLimit', active: true });
  for (let i = 0; i < 1500; i++) engine.tick();
  return serializeState(engine.state);
}

function expectSameFields(decoded: SaveGame, original: SaveGame): void {
  for (const key of Object.keys(original) as (keyof SaveGame)[]) {
    if (key === 'layers' || key === 'lifetime') continue;
    expect(decoded[key], key).toEqual(original[key]);
  }
  expect(decoded.lifetime).toBeUndefined();
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Re-packs a payload by hand: [format byte][uint32 LE header length][header][layer bytes]. */
async function pack(format: number, header: unknown, layerBytes: Uint8Array): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new Uint8Array(5 + json.length + layerBytes.length);
  buffer[0] = format;
  new DataView(buffer.buffer).setUint32(1, json.length, true);
  buffer.set(json, 5);
  buffer.set(layerBytes, 5 + json.length);
  return toBase64Url(await deflateRaw(buffer));
}

async function reasonOf(code: string): Promise<string> {
  try {
    await decodeShareCode(code);
  } catch (error) {
    expect(error).toBeInstanceOf(ShareCodeError);
    return (error as ShareCodeError).reason;
  }
  throw new Error('expected decodeShareCode to throw');
}

function smallSave(): SaveGame {
  const save = fullSave();
  return { ...save, lifetime: undefined };
}

/** A valid prefix followed by `zeros` zero bytes: inflates past the cap. */
async function zipBombCode(zeros = SHARE_MAX_BYTES): Promise<string> {
  const header = new TextEncoder().encode(JSON.stringify(saveFieldsToJson(smallSave())));
  const prefix = new Uint8Array(5 + header.length);
  prefix[0] = SHARE_FORMAT_VERSION;
  new DataView(prefix.buffer).setUint32(1, header.length, true);
  prefix.set(header, 5);
  const chunk = new Uint8Array(1 << 20);
  let remaining = zeros;
  let sentPrefix = false;
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        controller.enqueue(prefix);
      } else if (remaining > 0) {
        const n = Math.min(remaining, chunk.length);
        controller.enqueue(chunk.subarray(0, n));
        remaining -= n;
      } else {
        controller.close();
      }
    },
  });
  const compressed = new Uint8Array(
    await new Response(source.pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
  );
  return toBase64Url(compressed);
}

describe('share code', () => {
  it('round-trips a grown city with a credit and an ordinance', async () => {
    const save = grownCity();
    const original = deserializeState(save);
    expect(countPopulationAndJobs(original).population).toBeGreaterThan(0);
    expect(original.finance.credits.length).toBe(1);
    expect(original.policies.speedLimit).toBe(true);

    const decoded = await decodeShareCode(await encodeShareCode(save));
    expectSameFields(decoded, save);
    for (const name of SAVE_LAYERS) {
      const layer = save.layers[name];
      const expected = layer ? new Uint8Array(layer) : new Uint8Array(save.size * save.size); // absent → zeros
      expect(new Uint8Array(decoded.layers[name]!), name).toEqual(expected);
    }
    expect(countPopulationAndJobs(deserializeState(decoded))).toEqual(
      countPopulationAndJobs(original),
    );
  });

  it('round-trips every save field except the history', async () => {
    const save = fullSave();
    const decoded = await decodeShareCode(await encodeShareCode(save));
    expectSameFields(decoded, save);
    for (const name of SAVE_LAYERS) {
      expect(new Uint8Array(decoded.layers[name]!), name).toEqual(
        new Uint8Array(save.layers[name]),
      );
    }
  });

  it('uses only base64url characters', async () => {
    const code = await encodeShareCode(fullSave());
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('round-trips base64url for every byte value', () => {
    const bytes = new Uint8Array(256 * 3 + 1).map((_, i) => i & 0xff);
    expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
  });

  it('rejects an unknown format byte as version', async () => {
    const save = smallSave();
    const area = save.size * save.size;
    const code = await pack(
      SHARE_FORMAT_VERSION + 1,
      saveFieldsToJson(save),
      new Uint8Array(area * 7),
    );
    expect(await reasonOf(code)).toBe('version');
  });

  it('rejects a different save version as version', async () => {
    const save = smallSave();
    const area = save.size * save.size;
    const header = { ...saveFieldsToJson(save), version: SAVE_VERSION + 1 };
    const code = await pack(SHARE_FORMAT_VERSION, header, new Uint8Array(area * 7));
    expect(await reasonOf(code)).toBe('version');
  });

  it('rejects a truncated code', async () => {
    const code = await encodeShareCode(fullSave());
    expect(['format', 'corrupt']).toContain(await reasonOf(code.slice(0, code.length / 2)));
    expect(['format', 'corrupt']).toContain(await reasonOf(code.slice(0, 10)));
  });

  it('rejects text that is not base64url as format', async () => {
    expect(await reasonOf('!!!')).toBe('format');
    expect(await reasonOf('')).toBe('format');
    expect(await reasonOf('A')).toBe('format');
  });

  it('rejects a valid deflate stream that is not a city as corrupt', async () => {
    const code = toBase64Url(await deflateRaw(new TextEncoder().encode('hello')));
    expect(await reasonOf(code)).toBe('corrupt');
  });

  it('rejects a header that is not JSON or not a save as corrupt', async () => {
    const save = smallSave();
    const area = save.size * save.size;
    expect(await reasonOf(await pack(SHARE_FORMAT_VERSION, null, new Uint8Array(area * 7)))).toBe(
      'corrupt',
    );
    expect(
      await reasonOf(
        await pack(SHARE_FORMAT_VERSION, { version: SAVE_VERSION }, new Uint8Array(area * 7)),
      ),
    ).toBe('corrupt');
    const bad = new Uint8Array([SHARE_FORMAT_VERSION, 3, 0, 0, 0, 0x7b, 0x7b, 0x7b]);
    expect(await reasonOf(toBase64Url(await deflateRaw(bad)))).toBe('corrupt');
    const overlong = new Uint8Array([SHARE_FORMAT_VERSION, 0xff, 0xff, 0, 0, 0x7b]);
    expect(await reasonOf(toBase64Url(await deflateRaw(overlong)))).toBe('corrupt');
  });

  it('accepts exactly the selectable map sizes range and every scenario map', () => {
    expect(SHARE_MIN_MAP_SIZE).toBe(Math.min(...MAP_SIZES));
    expect(SHARE_MAX_MAP_SIZE).toBe(Math.max(...MAP_SIZES));
    for (const id of SCENARIO_IDS) {
      const { size } = scenarioDef(id);
      expect(size, id).toBeGreaterThanOrEqual(SHARE_MIN_MAP_SIZE);
      expect(size, id).toBeLessThanOrEqual(SHARE_MAX_MAP_SIZE);
    }
  });

  it('rejects a map size outside the share range as corrupt', async () => {
    const fields = saveFieldsToJson(smallSave());
    const withSize = (size: number) =>
      pack(SHARE_FORMAT_VERSION, { ...fields, size }, new Uint8Array(size * size * 7));
    for (const size of [1, SHARE_MIN_MAP_SIZE - 1, SHARE_MAX_MAP_SIZE + 1]) {
      expect(await reasonOf(await withSize(size)), String(size)).toBe('corrupt');
    }
    for (const size of [SHARE_MIN_MAP_SIZE, SHARE_MAX_MAP_SIZE]) {
      expect((await decodeShareCode(await withSize(size))).size).toBe(size);
    }
  });

  it('rejects too few or misaligned layer bytes as corrupt', async () => {
    const save = smallSave();
    const area = save.size * save.size;
    const header = saveFieldsToJson(save);
    expect(await reasonOf(await pack(SHARE_FORMAT_VERSION, header, new Uint8Array(area * 6)))).toBe(
      'corrupt',
    );
    expect(
      await reasonOf(await pack(SHARE_FORMAT_VERSION, header, new Uint8Array(area * 7 + 1))),
    ).toBe('corrupt');
    expect(
      await reasonOf(
        await pack(SHARE_FORMAT_VERSION, header, new Uint8Array(area * SAVE_LAYERS.length + 1)),
      ),
    ).toBe('corrupt');
  });

  it('ignores whole layers beyond the known ones (a newer build appended them)', async () => {
    const save = smallSave();
    const area = save.size * save.size;
    const bytes = new Uint8Array(area * (SAVE_LAYERS.length + 2));
    bytes.fill(1, 0, area);
    bytes.fill(9, area * SAVE_LAYERS.length);
    const decoded = await decodeShareCode(
      await pack(SHARE_FORMAT_VERSION, saveFieldsToJson(save), bytes),
    );
    expect(Object.keys(decoded.layers)).toEqual([...SAVE_LAYERS]);
    expect(new Uint8Array(decoded.layers.tileType)[0]).toBe(1);
    expect(new Uint8Array(decoded.layers[SAVE_LAYERS[SAVE_LAYERS.length - 1]]!)).toEqual(
      new Uint8Array(area),
    );
  });

  it('accepts the required layers alone and leaves later layers absent', async () => {
    const save = smallSave();
    const area = save.size * save.size;
    const code = await pack(SHARE_FORMAT_VERSION, saveFieldsToJson(save), new Uint8Array(area * 7));
    const decoded = await decodeShareCode(code);
    expect(new Uint8Array(decoded.layers.tileType).length).toBe(area);
    expect(decoded.layers[SAVE_LAYERS[7]]).toBeUndefined();
  });

  it('stops inflating a zip bomb as tooLarge', async () => {
    expect(await reasonOf(await zipBombCode())).toBe('tooLarge');
  });

  it('feeds a large single-chunk code to the inflater in small slices', async () => {
    // WebKit may inflate a whole input chunk at once, so the decoder must
    // never hand it more than one slice: the code arrives as one buffer.
    // Zeros deflate about 700:1 here, so 16 caps give several slices of input.
    const code = await zipBombCode(16 * SHARE_MAX_BYTES);
    const compressedLength = fromBase64Url(code).length;
    const Real = globalThis.DecompressionStream;
    const written: number[] = [];
    class Recording {
      readonly readable: ReadableStream<Uint8Array>;
      readonly writable: WritableStream<BufferSource>;
      constructor(format: CompressionFormat) {
        const inner = new Real(format);
        const innerWriter = inner.writable.getWriter();
        this.readable = inner.readable;
        this.writable = new WritableStream<BufferSource>({
          write(chunk) {
            written.push(chunk.byteLength);
            return innerWriter.write(chunk);
          },
          close: () => innerWriter.close(),
          abort: (reason) => innerWriter.abort(reason),
        });
      }
    }
    vi.stubGlobal('DecompressionStream', Recording);
    try {
      expect(await reasonOf(code)).toBe('tooLarge');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(compressedLength).toBeGreaterThan(SHARE_INFLATE_SLICE);
    expect(Math.max(...written)).toBeLessThanOrEqual(SHARE_INFLATE_SLICE);
  });

  it('rejects an oversized code string as tooLarge without decoding', async () => {
    expect(await reasonOf('A'.repeat(SHARE_MAX_CODE_LENGTH + 1))).toBe('tooLarge');
  });
});
