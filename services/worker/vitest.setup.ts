// @sentry/profiling-node ships prebuilt native binaries keyed to Node ABI version.
// Node 25 (ABI 141) has no binary in 10.53.x/10.54.x — mock globally so tests load.
import { vi } from 'vitest';

vi.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: vi.fn(() => ({})),
}));
