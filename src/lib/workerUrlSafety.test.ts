import { describe, expect, it } from 'vitest';
import { resolveSafeWorkerEndpoint } from './workerUrlSafety';

describe('resolveSafeWorkerEndpoint', () => {
  it('allows HTTPS worker endpoints', () => {
    expect(resolveSafeWorkerEndpoint('https://worker.example.test', '/api/status').toString())
      .toBe('https://worker.example.test/api/status');
  });

  it('allows localhost HTTP for local development', () => {
    expect(resolveSafeWorkerEndpoint('http://localhost:3001', '/api/status').toString())
      .toBe('http://localhost:3001/api/status');
    expect(resolveSafeWorkerEndpoint('http://127.0.0.1:3001', '/api/status').toString())
      .toBe('http://127.0.0.1:3001/api/status');
  });

  it('rejects non-local HTTP worker endpoints before bearer tokens are attached', () => {
    expect(() => resolveSafeWorkerEndpoint('http://worker.example.test', '/api/status'))
      .toThrow('Worker endpoint must use HTTPS outside localhost.');
  });
});
