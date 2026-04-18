/**
 * Simple percentile helper shared by benchmarks.
 *
 * Accepts an unsorted numeric array and either a 0–1 fraction (0.5, 0.95)
 * or a 0–100 percentile (50, 95). Returns 0 for an empty array so callers
 * can log sensibly without guarding every reference.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const fraction = p > 1 ? p / 100 : p;
  const idx = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[idx];
}
