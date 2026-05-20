/**
 * Global vitest setup — mocks native modules that aren't available on
 * every platform/Node ABI combination (e.g. Sentry CPU profiler has no
 * prebuilt binary for Node ABI 141 on darwin-arm64).
 */
import { vi } from 'vitest';

vi.mock('@sentry-internal/node-cpu-profiler', () => ({
  CpuProfilerBindings: {
    startProfiling: vi.fn(),
    stopProfiling: vi.fn(() => ({
      samples: [],
      stacks: [],
      frames: [],
      thread_metadata: {},
    })),
  },
}));

vi.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: vi.fn(() => ({})),
}));
