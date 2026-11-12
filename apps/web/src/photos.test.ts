import { afterEach, expect, it, vi } from 'vitest';
import { compressPhoto } from './photos.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('resizes and re-encodes photos as bounded JPEGs and releases the bitmap', async () => {
  const close = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close })));
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage } as unknown as CanvasRenderingContext2D);
  const sizes: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback, type) {
    sizes.push([this.width, this.height]); callback(new Blob(['jpeg'], { type }));
  });
  const result = await compressPhoto(new File(['photo'], 'lamp.png', { type: 'image/png' }));
  expect(result.type).toBe('image/jpeg'); expect(sizes).toEqual([[1600, 1200]]);
  expect(drawImage).toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
});
it('accepts a 48 megapixel photo', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 8000, height: 6000, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => callback(new Blob(['jpeg'], { type })));
  expect((await compressPhoto(new File(['photo'], 'phone.jpg', { type: 'image/jpeg' }))).type).toBe('image/jpeg');
});
it('rejects unsupported or oversized files before decoding', async () => {
  const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
  await expect(compressPhoto(new File(['svg'], 'lamp.svg', { type: 'image/svg+xml' }))).rejects.toThrow();
  await expect(compressPhoto(new File([new Uint8Array(21 * 1024 * 1024)], 'lamp.jpg', { type: 'image/jpeg' }))).rejects.toThrow();
  expect(decode).not.toHaveBeenCalled();
});
