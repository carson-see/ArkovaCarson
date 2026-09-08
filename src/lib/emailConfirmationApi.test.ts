import { afterEach, describe, expect, it, vi } from 'vitest';
import { completeEmailConfirmation, getConfirmationStatus } from './emailConfirmationApi';
const { workerFetch } = vi.hoisted(() => ({ workerFetch: vi.fn() }));
vi.mock('./workerClient', () => ({ workerFetch, WORKER_URL: 'http://localhost:3001' }));
vi.mock('./workerUrlSafety', () => ({ resolveSafeWorkerEndpoint: (base: string, path: string) => new URL(path, base) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('confirmation transport recovery', () => {
  it('hides malformed proxy responses and offline details behind safe retry copy', async () => {
    workerFetch.mockResolvedValue(new Response('<private proxy error>', { status: 502 }));
    await expect(getConfirmationStatus()).rejects.toThrow('We could not complete this step. Please try again.');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('private network detail')));
    await expect(completeEmailConfirmation('mailbox-proof')).rejects.toThrow('We could not complete this step. Please try again.');
  });
});
