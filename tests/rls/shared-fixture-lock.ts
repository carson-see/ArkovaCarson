import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lockRoot = join(tmpdir(), 'arkova-rls-shared-fixtures');
const defaultWaitTimeoutMs = 25_000;

interface LockOptions {
  waitTimeoutMs?: number;
  signal?: AbortSignal;
}

function abortedLockError(name: string): Error {
  const error = new Error(`Cancelled while waiting for shared RLS fixture lock: ${name}`);
  error.name = 'AbortError';
  return error;
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined, name: string): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, delayMs));
  if (signal.aborted) return Promise.reject(abortedLockError(name));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedLockError(name));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function canonicalResource(resource: string): string {
  try {
    const parsed = new URL(resource);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) return resource;
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
    const host = loopback ? 'loopback' : parsed.hostname.toLowerCase();
    return `postgresql://${host}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return resource;
  }
}

export function sharedFixtureLockPath(name: string, resource: string): string {
  const key = createHash('sha256').update(name).update('\0').update(canonicalResource(resource)).digest('hex');
  return join(lockRoot, `${key}.lock`);
}

/** Acquire an atomic cross-worker lock for a mutable shared RLS fixture. */
export async function acquireSharedFixtureLock(
  name: string,
  resource: string,
  options: LockOptions = {},
): Promise<() => void> {
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = sharedFixtureLockPath(name, resource);
  const startedAt = Date.now();
  const waitTimeoutMs = options.waitTimeoutMs ?? defaultWaitTimeoutMs;
  let firstAttempt = true;

  for (;;) {
    if (options.signal?.aborted) throw abortedLockError(name);
    if (!firstAttempt && Date.now() - startedAt >= waitTimeoutMs) {
      throw new Error(`Timed out waiting for shared RLS fixture lock: ${name}`);
    }
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      // A lifecycle owner may cancel while this waiter is between its last
      // signal check and atomic mkdir. Never return a late-acquired lock after
      // cleanup has already run.
      if (options.signal?.aborted) {
        rmSync(lockPath, { recursive: true, force: true });
        throw abortedLockError(name);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - startedAt >= waitTimeoutMs) {
        throw new Error(`Timed out waiting for shared RLS fixture lock: ${name}`);
      }
      const remainingMs = waitTimeoutMs - (Date.now() - startedAt);
      await waitForRetry(Math.min(50, Math.max(1, remainingMs)), options.signal, name);
      firstAttempt = false;
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(lockPath, { recursive: true, force: true });
  };
}

/** Run work while excluding other Vitest workers that use the same fixture. */
export async function withSharedFixtureLock<T>(
  name: string,
  resource: string,
  work: () => Promise<T>,
): Promise<T> {
  const release = await acquireSharedFixtureLock(name, resource);
  try {
    return await work();
  } finally {
    release();
  }
}
