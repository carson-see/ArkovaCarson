import { describe, expect, it } from 'vitest';
import { WorkerResponseError, isWorkerResponseError } from './workerResponseError';

describe('WorkerResponseError / isWorkerResponseError', () => {
  it('carries the message it was constructed with', () => {
    const err = new WorkerResponseError('Nessie query endpoint is not enabled');
    expect(err.message).toBe('Nessie query endpoint is not enabled');
    expect(err.name).toBe('WorkerResponseError');
    expect(err).toBeInstanceOf(Error);
  });

  it('isWorkerResponseError is true only for WorkerResponseError instances', () => {
    expect(isWorkerResponseError(new WorkerResponseError('server said so'))).toBe(true);
    expect(isWorkerResponseError(new Error('some other internal detail'))).toBe(false);
    expect(isWorkerResponseError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isWorkerResponseError('a bare string')).toBe(false);
    expect(isWorkerResponseError(undefined)).toBe(false);
    expect(isWorkerResponseError(null)).toBe(false);
  });
});
