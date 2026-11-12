import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { checkTagUrl, decodeQr, pngOf } from './tag.ts';

const QRCode = createRequire(new URL('../../apps/api/package.json', import.meta.url))('qrcode') as { toDataURL(text: string, options: object): Promise<string> };
const tagImage = (url: string) => QRCode.toDataURL(url, { margin: 4, scale: 6, errorCorrectionLevel: 'M' });

describe('decodeQr', () => {
  it('reads the URL out of a generated tag image', async () => {
    expect(decodeQr(pngOf(await tagImage('https://stall.example/i/K7Q2')))).toBe('https://stall.example/i/K7Q2');
  });

  it('returns null for an image with no code in it', () => {
    const blank = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    expect(decodeQr(pngOf(blank))).toBeNull();
  });

  it('refuses an image that is not a PNG data URL', () => {
    expect(() => pngOf('https://stall.example/tag.png')).toThrow('not a PNG data URL');
  });
});

describe('checkTagUrl', () => {
  const base = 'https://stall.example';
  it('accepts the item page on the service host', () => { expect(checkTagUrl('https://stall.example/i/K7Q2', base, 'K7Q2')).toEqual([]); });
  it('rejects another code, another host, and anything after the code', () => {
    expect(checkTagUrl('https://stall.example/i/ZZZZ', base, 'K7Q2')).toHaveLength(1);
    expect(checkTagUrl('https://other.example/i/K7Q2', base, 'K7Q2')).toHaveLength(1);
    expect(checkTagUrl('https://stall.example/i/K7Q2?price=1800', base, 'K7Q2')).toHaveLength(1);
  });
  it('rejects a missing or non-URL decode', () => {
    expect(checkTagUrl(null, base, 'K7Q2')).toEqual(['The tag image did not decode to a URL.']);
    expect(checkTagUrl('K7Q2', base, 'K7Q2')).toEqual(['The tag image decoded to text that is not a URL.']);
  });
});
