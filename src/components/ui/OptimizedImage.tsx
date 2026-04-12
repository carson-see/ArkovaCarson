/**
 * Optimized Image Component (PERF-10)
 *
 * Wraps <img> with performance best practices:
 * - loading="lazy" for below-fold images (default)
 * - loading="eager" + fetchpriority="high" for hero/above-fold
 * - Explicit width/height to prevent CLS (Cumulative Layout Shift)
 * - decoding="async" for non-blocking decode
 */

import type { ImgHTMLAttributes } from 'react';

interface OptimizedImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  /** Set to true for above-the-fold hero images */
  priority?: boolean;
}

export function OptimizedImage({ priority, ...props }: OptimizedImageProps) {
  return (
    <img
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      {...(priority ? { fetchPriority: 'high' } : {})}
      {...props}
    />
  );
}
