// Decodes the QR image a printed tag carries, so a take can show that the code opens the item it
// was printed for. The image comes from the owner's print sheet, the page the owner prints from,
// and the URL comes from decoding its pixels, never from reading text on the page.

import { createRequire } from 'node:module';

// The slice of `jsqr` and `pngjs` this file uses. Both live in the API's dependencies, so they are loaded from there.
type Decode = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
interface PngModule { PNG: { sync: { read(buffer: Buffer): { data: Buffer; width: number; height: number } } } }

const fromApi = createRequire(new URL('../../apps/api/package.json', import.meta.url));

export const pngOf = (dataUrl: string) => {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('The tag image is not a PNG data URL.');
  return Buffer.from(match[1]!, 'base64');
};

/** The text a QR PNG encodes, or null when no code can be read from it. */
export function decodeQr(png: Buffer): string | null {
  const jsQR = fromApi('jsqr') as Decode;
  const { PNG } = fromApi('pngjs') as PngModule;
  const image = PNG.sync.read(png);
  return jsQR(new Uint8ClampedArray(image.data), image.width, image.height)?.data ?? null;
}

/**
 * What is wrong with a decoded tag URL: it must be the item's page on this host, with the code in
 * the path and nothing after it, so no price or floor can travel in the tag.
 */
export function checkTagUrl(decoded: string | null, base: string, code: string): string[] {
  if (!decoded) return ['The tag image did not decode to a URL.'];
  let url: URL;
  try { url = new URL(decoded); } catch { return ['The tag image decoded to text that is not a URL.']; }
  const problems: string[] = [];
  if (url.origin !== new URL(base).origin) problems.push('The tag URL is on a different host from the service.');
  if (url.pathname !== `/i/${code}`) problems.push('The tag URL does not name this item\'s code.');
  if (url.search || url.hash) problems.push('The tag URL carries more than the item code.');
  return problems;
}
