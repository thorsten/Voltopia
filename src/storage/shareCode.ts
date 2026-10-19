/**
 * Share code: a whole city packed into a URL-safe string.
 *
 * Format v1: deflate-raw of
 * `[format byte][uint32 LE header length][header JSON][raw layers in SAVE_LAYERS order]`
 * (later formats must keep the five-byte prefix),
 * encoded as base64url. The header JSON is `saveFieldsToJson` without the
 * history (`lifetime`). The layer count follows from the payload length,
 * so a newer build that appends a layer to `SAVE_LAYERS` still reads
 * older codes, and an older build skips the layers it does not know.
 *
 * DOM-free: only `CompressionStream`, `DecompressionStream`, `Blob`,
 * `Response`, `TextEncoder`/`TextDecoder` and `btoa`/`atob`.
 */
import { MAP_SIZES, SAVE_VERSION } from '../shared/constants.ts';
import type { SaveGame } from '../shared/types.ts';
import {
  REQUIRED_LAYER_COUNT,
  SAVE_LAYERS,
  type SaveFields,
  saveFieldsFromJson,
  saveFieldsToJson,
} from './serialization.ts';

export const SHARE_FORMAT_VERSION = 1;
/**
 * Map sizes a share code may carry: the selectable ones (every scenario
 * map lies within them too). Anything else is a forged or broken code.
 */
export const SHARE_MIN_MAP_SIZE = Math.min(...MAP_SIZES);
export const SHARE_MAX_MAP_SIZE = Math.max(...MAP_SIZES);
/** Format byte + uint32 header length. */
const HEADER_OFFSET = 5;
/** 1 MB of header JSON at most. */
const HEADER_SLACK = 1 << 20;
/** Zip-bomb guard: decompression stops beyond this many bytes. */
export const SHARE_MAX_BYTES =
  SHARE_MAX_MAP_SIZE * SHARE_MAX_MAP_SIZE * SAVE_LAYERS.length + HEADER_SLACK;
/** Codes longer than this are rejected before decoding (base64 of the cap's deflate bound). */
export const SHARE_MAX_CODE_LENGTH = 4 * 1024 * 1024;
/** btoa/fromCharCode chunk size: keeps the spread argument list small. */
const BASE64_CHUNK = 0x2000;

export type ShareCodeErrorReason = 'format' | 'version' | 'corrupt' | 'tooLarge';

export class ShareCodeError extends Error {
  readonly reason: ShareCodeErrorReason;
  constructor(reason: ShareCodeErrorReason, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ShareCodeError';
    this.reason = reason;
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
    throw new ShareCodeError('format', 'not base64url');
  }
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Compressed bytes handed to the inflater at a time. WebKit may inflate a
 * whole input chunk in one go, so the output cap is only effective when
 * no single chunk can expand far past it (deflate tops out near 1:1032).
 */
export const SHARE_INFLATE_SLICE = 8 * 1024;

/**
 * Inflates, aborting as soon as the output exceeds `limit` bytes. The
 * input is written in `SHARE_INFLATE_SLICE` pieces while the output is
 * read, so a bomb stops after one slice's worth of expansion.
 */
async function inflateRawLimited(
  bytes: Uint8Array<ArrayBuffer>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const inflater = new DecompressionStream('deflate-raw');
  const writer = inflater.writable.getWriter();
  const reader = inflater.readable.getReader();
  let stopped = false;
  const feed = (async () => {
    for (let i = 0; i < bytes.length && !stopped; i += SHARE_INFLATE_SLICE) {
      await writer.write(bytes.subarray(i, i + SHARE_INFLATE_SLICE));
    }
    if (!stopped) await writer.close();
  })();
  // A corrupt stream errors both sides; the reader reports it.
  feed.catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        stopped = true;
        await Promise.all([reader.cancel().catch(() => {}), writer.abort().catch(() => {})]);
        throw new ShareCodeError('tooLarge');
      }
      chunks.push(value);
    }
  } catch (error) {
    stopped = true;
    if (error instanceof ShareCodeError) throw error;
    throw new ShareCodeError('corrupt', String(error));
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Packs a save into a share code. A shared city starts with an empty history. */
export async function encodeShareCode(save: SaveGame): Promise<string> {
  const header = new TextEncoder().encode(
    JSON.stringify({ ...saveFieldsToJson(save), lifetime: undefined }),
  );
  const area = save.size * save.size;
  const buffer = new Uint8Array(HEADER_OFFSET + header.length + SAVE_LAYERS.length * area);
  buffer[0] = SHARE_FORMAT_VERSION;
  new DataView(buffer.buffer).setUint32(1, header.length, true);
  buffer.set(header, HEADER_OFFSET);
  let offset = HEADER_OFFSET + header.length;
  for (const name of SAVE_LAYERS) {
    const layer = save.layers[name];
    if (layer) buffer.set(new Uint8Array(layer), offset); // absent → zeros = layer default
    offset += area;
  }
  return toBase64Url(await deflateRaw(buffer));
}

/**
 * Unpacks a share code. Every failure is a `ShareCodeError`; the decoder
 * never inflates more than `SHARE_MAX_BYTES`.
 */
export async function decodeShareCode(code: string): Promise<SaveGame> {
  if (code.length > SHARE_MAX_CODE_LENGTH) throw new ShareCodeError('tooLarge');
  const bytes = await inflateRawLimited(fromBase64Url(code), SHARE_MAX_BYTES);
  if (bytes.length < HEADER_OFFSET) throw new ShareCodeError('corrupt', 'too short');
  // The prefix (format byte + header length) is shared by every format, so
  // a header length that overruns the payload means garbage, not a newer format.
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true);
  const layersStart = HEADER_OFFSET + headerLength;
  if (layersStart > bytes.length) throw new ShareCodeError('corrupt', 'header length');
  if (bytes[0] !== SHARE_FORMAT_VERSION) {
    throw new ShareCodeError('version', `format ${bytes[0]}`);
  }
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_OFFSET, layersStart)),
    );
  } catch (error) {
    throw new ShareCodeError('corrupt', String(error));
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new ShareCodeError('corrupt', 'header');
  }
  // saveFieldsFromJson rejects a version mismatch generically: check first.
  if ((header as { version?: unknown }).version !== SAVE_VERSION) {
    throw new ShareCodeError('version', 'save version');
  }
  let fields: SaveFields;
  try {
    fields = saveFieldsFromJson(header);
  } catch (error) {
    throw new ShareCodeError('corrupt', String(error));
  }
  const { size } = fields;
  if (!Number.isInteger(size) || size < SHARE_MIN_MAP_SIZE || size > SHARE_MAX_MAP_SIZE) {
    throw new ShareCodeError('corrupt', `size ${size}`);
  }
  const area = size * size;
  const count = (bytes.length - layersStart) / area;
  if (!Number.isInteger(count) || count < REQUIRED_LAYER_COUNT) {
    throw new ShareCodeError('corrupt', 'layer bytes');
  }
  // Whole layers beyond the known ones come from a newer build: skip them.
  const layers = {} as SaveGame['layers'];
  for (let i = 0; i < Math.min(count, SAVE_LAYERS.length); i++) {
    const start = layersStart + i * area;
    layers[SAVE_LAYERS[i]] = bytes.slice(start, start + area).buffer;
  }
  const result: SaveGame = { ...fields, layers };
  delete result.lifetime;
  return result;
}
