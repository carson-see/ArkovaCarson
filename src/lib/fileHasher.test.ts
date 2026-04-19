/**
 * FileHasher Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateFingerprint, verifyFingerprint, formatFingerprint, hashEmail } from './fileHasher';

describe('generateFingerprint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should generate SHA-256 hash using crypto.subtle.digest', async () => {
    // Create file with arrayBuffer method
    const content = 'test content';
    const file = new File([content], 'test.txt', { type: 'text/plain' });

    const fingerprint = await generateFingerprint(file);

    // Should be 64 hex characters
    expect(fingerprint).toHaveLength(64);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should produce consistent hashes for same content', async () => {
    const content = 'identical content';
    const file1 = new File([content], 'file1.txt');
    const file2 = new File([content], 'file2.txt');

    const hash1 = await generateFingerprint(file1);
    const hash2 = await generateFingerprint(file2);

    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different content', async () => {
    const file1 = new File(['content A'], 'file1.txt');
    const file2 = new File(['content B'], 'file2.txt');

    const hash1 = await generateFingerprint(file1);
    const hash2 = await generateFingerprint(file2);

    expect(hash1).not.toBe(hash2);
  });

  it('rejects with FileReader error message when reader.onerror fires', async () => {
    // Covers the `reader.onerror` branch in readAsArrayBuffer — previously
    // uncovered, which left branch coverage at 66.66% and failed the 80%
    // CI threshold.
    const OriginalFileReader = globalThis.FileReader;
    class ErroringFileReader extends OriginalFileReader {
      readAsArrayBuffer(_blob: Blob) {
        setTimeout(() => {
          Object.defineProperty(this, 'error', {
            value: new DOMException('simulated read error', 'NotReadableError'),
            configurable: true,
          });
          this.onerror?.(new ProgressEvent('error'));
        }, 0);
      }
    }
    globalThis.FileReader = ErroringFileReader as unknown as typeof FileReader;

    try {
      const file = new File(['x'], 'x.bin');
      await expect(generateFingerprint(file)).rejects.toThrow(/FileReader error: simulated read error/);
    } finally {
      globalThis.FileReader = OriginalFileReader;
    }
  });

  it('rejects with timeout message when hashing exceeds 30s', async () => {
    // Covers the timeout race branch in generateFingerprint. Uses fake
    // timers so the test completes instantly.
    vi.useFakeTimers();
    const OriginalFileReader = globalThis.FileReader;
    // Stub FileReader to never resolve so the timeout wins.
    class StallingFileReader extends OriginalFileReader {
      readAsArrayBuffer(_blob: Blob) {
        // never call onload / onerror
      }
    }
    globalThis.FileReader = StallingFileReader as unknown as typeof FileReader;

    try {
      const file = new File(['x'], 'x.bin');
      const assertion = expect(generateFingerprint(file)).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally {
      globalThis.FileReader = OriginalFileReader;
      vi.useRealTimers();
    }
  });
});

describe('verifyFingerprint', () => {
  it('should return true for matching fingerprints', async () => {
    const content = 'verify me';
    const file = new File([content], 'test.txt');

    const fingerprint = await generateFingerprint(file);
    const result = await verifyFingerprint(file, fingerprint);

    expect(result).toBe(true);
  });

  it('should return false for non-matching fingerprints', async () => {
    const file = new File(['content'], 'test.txt');
    const wrongHash = '0'.repeat(64);

    const result = await verifyFingerprint(file, wrongHash);

    expect(result).toBe(false);
  });

  it('should be case-insensitive', async () => {
    const file = new File(['case test'], 'test.txt');
    const fingerprint = await generateFingerprint(file);

    const result = await verifyFingerprint(file, fingerprint.toUpperCase());

    expect(result).toBe(true);
  });
});

describe('formatFingerprint', () => {
  it('should format long fingerprints with ellipsis', () => {
    const fullHash = 'a'.repeat(64);
    const formatted = formatFingerprint(fullHash);
    expect(formatted).toBe('aaaaaaaaaaaaaaaa...aaaaaaaa');
  });

  it('should use custom prefix and suffix lengths', () => {
    const fullHash = 'abcdefghij1234567890';
    const formatted = formatFingerprint(fullHash, 4, 4);
    expect(formatted).toBe('abcd...7890');
  });

  it('should return full string if shorter than combined lengths', () => {
    const shortHash = 'abc123';
    const formatted = formatFingerprint(shortHash, 10, 10);
    expect(formatted).toBe('abc123');
  });
});

describe('hashEmail', () => {
  it('should produce a 64-character hex hash', async () => {
    const hash = await hashEmail('test@example.com');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should produce consistent hashes for same email', async () => {
    const hash1 = await hashEmail('test@example.com');
    const hash2 = await hashEmail('test@example.com');
    expect(hash1).toBe(hash2);
  });

  it('should normalize email to lowercase', async () => {
    const hash1 = await hashEmail('Test@Example.COM');
    const hash2 = await hashEmail('test@example.com');
    expect(hash1).toBe(hash2);
  });

  it('should trim whitespace', async () => {
    const hash1 = await hashEmail('  test@example.com  ');
    const hash2 = await hashEmail('test@example.com');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different emails', async () => {
    const hash1 = await hashEmail('alice@example.com');
    const hash2 = await hashEmail('bob@example.com');
    expect(hash1).not.toBe(hash2);
  });
});
