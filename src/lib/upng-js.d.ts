/**
 * Ambient types for `upng-js` (MIT). Upstream ships no `.d.ts`; this covers
 * only the encode surface `ocrWorker.ts` uses to turn decoded TIFF/HEIC RGBA
 * pixel buffers into real PNG bytes (canvas-free, works in-browser and under
 * Node/Vitest alike).
 */
declare module 'upng-js' {
  interface UPNG {
    /**
     * Encodes one or more RGBA frames into a PNG.
     * @param imgs RGBA8 frame buffers (one per animation frame; pass a single
     *   entry for a static image).
     * @param w Width in pixels.
     * @param h Height in pixels.
     * @param cnum Palette size cap; `0` = lossless truecolor (no quantization).
     */
    encode(imgs: ArrayBuffer[], w: number, h: number, cnum: number): ArrayBuffer;
  }

  const upng: UPNG;
  export default upng;
}
