/**
 * Ambient types for `heic-decode` (ISC wrapper around `libheif-js`, LGPL-3.0
 * upstream — see `src/lib/ocrWorker.ts` module header for the license note).
 * Upstream ships no `.d.ts`; this covers only the surface `ocrWorker.ts` uses.
 */
declare module 'heic-decode' {
  export interface HeicDecodedImage {
    /** Pixel width of the decoded image. */
    width: number;
    /** Pixel height of the decoded image. */
    height: number;
    /** RGBA pixel data, 4 bytes per pixel, row-major. */
    data: Uint8ClampedArray;
  }

  export interface HeicDecodeInput {
    buffer: ArrayBuffer | ArrayBufferView;
  }

  /** Decodes the primary/first image in the HEIC/HEIF file. */
  export default function decode(input: HeicDecodeInput): Promise<HeicDecodedImage>;
}
