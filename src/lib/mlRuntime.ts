/**
 * ML Runtime Detection & Management (Phase 4)
 *
 * CLIENT-SIDE ONLY — detects WebGPU availability and manages
 * VRAM budget for in-browser ML models.
 *
 * Constitution 1.6: All ML inference runs client-side.
 * Budget: 2GB VRAM maximum for client-side models.
 */

/** Maximum VRAM budget in bytes (2GB) */
export const VRAM_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

/** Maximum VRAM budget in MB */
export const VRAM_BUDGET_MB = 2048;

export type MLBackend = 'webgpu' | 'wasm' | 'cpu';

export interface MLRuntimeInfo {
  /** Best available backend */
  backend: MLBackend;
  /** Whether WebGPU is available */
  webgpuAvailable: boolean;
  /** Whether WASM SIMD is available */
  wasmSimdAvailable: boolean;
  /** Estimated available VRAM in MB (null if unknown) */
  estimatedVramMb: number | null;
  /** Whether the model fits within the VRAM budget */
  withinBudget: boolean;
}

/** Cached runtime info to avoid re-detection */
let _cachedInfo: MLRuntimeInfo | null = null;

/**
 * Detect the best available ML backend.
 *
 * Priority: WebGPU > WASM (SIMD) > CPU
 * WebGPU is preferred for NER models as it provides ~3-5x speedup.
 */
export async function detectMLRuntime(): Promise<MLRuntimeInfo> {
  if (_cachedInfo) return _cachedInfo;

  const webgpuAvailable = await checkWebGPU();
  const wasmSimdAvailable = checkWasmSimd();

  let backend: MLBackend;
  let estimatedVramMb: number | null = null;

  if (webgpuAvailable) {
    backend = 'webgpu';
    estimatedVramMb = await estimateWebGPUVram();
  } else if (wasmSimdAvailable) {
    backend = 'wasm';
  } else {
    backend = 'cpu';
  }

  // NER model (bert-base-NER) is ~420MB quantized — well within 2GB
  const modelSizeMb = 420;
  const withinBudget = estimatedVramMb === null
    ? true // Assume it fits if we can't measure (WASM/CPU use system RAM)
    : estimatedVramMb >= modelSizeMb;

  _cachedInfo = {
    backend,
    webgpuAvailable,
    wasmSimdAvailable,
    estimatedVramMb,
    withinBudget,
  };

  return _cachedInfo;
}

/**
 * Check if WebGPU is available in this browser.
 */
async function checkWebGPU(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  if (!('gpu' in navigator)) return false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = (navigator as any).gpu;
    const adapter = await gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Check if WASM SIMD is available (enables faster CPU inference).
 */
function checkWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined') return false;
  try {
    // Test SIMD support by validating a minimal SIMD module
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123,
        3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
      ]),
    );
  } catch {
    return false;
  }
}

/**
 * Estimate available WebGPU VRAM by querying the adapter.
 * Returns null if estimation fails.
 */
async function estimateWebGPUVram(): Promise<number | null> {
  try {
    if (typeof navigator === 'undefined' || !('gpu' in navigator)) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = (navigator as any).gpu;
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;

    // maxBufferSize gives a rough indicator of available memory
    const limits = adapter.limits;
    const maxBufferSize = limits.maxBufferSize;
    // Convert to MB, cap at 8GB (reasonable upper bound)
    const estimatedMb = Math.min(Math.floor(maxBufferSize / (1024 * 1024)), 8192);
    return estimatedMb;
  } catch {
    return null;
  }
}

/**
 * Reset cached runtime info (useful for testing).
 */
export function resetMLRuntimeCache(): void {
  _cachedInfo = null;
}

/**
 * Check if a model of given size fits within the VRAM budget.
 */
export function fitsInVramBudget(modelSizeMb: number): boolean {
  return modelSizeMb <= VRAM_BUDGET_MB;
}
