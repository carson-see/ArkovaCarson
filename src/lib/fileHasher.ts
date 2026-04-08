/**
 * FileHasher Utility
 *
 * Client-side file fingerprinting using Web Crypto API.
 * Files are processed entirely in the browser - never uploaded to servers.
 */

/**
 * Read file as ArrayBuffer using FileReader (more reliable than file.arrayBuffer()
 * for files selected via native file picker).
 */
function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error(`FileReader error: ${reader.error?.message ?? 'unknown'}`));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Generate SHA-256 fingerprint for a file
 * Uses FileReader + Web Crypto API (crypto.subtle.digest).
 * 30-second timeout for very large files.
 *
 * @param file - The file to hash
 * @returns Promise<string> - Hex-encoded SHA-256 hash
 */
export async function generateFingerprint(file: File): Promise<string> {
  const TIMEOUT_MS = 30_000;

  const hashPromise = (async () => {
    const buffer = await readAsArrayBuffer(file);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  })();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Fingerprint generation timed out. Please try a smaller file or refresh the page.')), TIMEOUT_MS),
  );

  return Promise.race([hashPromise, timeoutPromise]);
}

/**
 * Verify a file matches an expected fingerprint
 *
 * @param file - The file to verify
 * @param expectedFingerprint - The expected SHA-256 hash
 * @returns Promise<boolean> - True if fingerprints match
 */
export async function verifyFingerprint(
  file: File,
  expectedFingerprint: string
): Promise<boolean> {
  const actualFingerprint = await generateFingerprint(file);
  return actualFingerprint.toLowerCase() === expectedFingerprint.toLowerCase();
}

/**
 * Hash an email address for privacy-preserving recipient matching.
 * Uses SHA-256 of lowercased, trimmed email. Both client (issuance)
 * and worker (auto-linking on signup) must use this same algorithm.
 *
 * @param email - The email address to hash
 * @returns Promise<string> - Hex-encoded SHA-256 hash
 */
export async function hashEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Format fingerprint for display (truncated with ellipsis)
 *
 * @param fingerprint - Full 64-character hex fingerprint
 * @param prefixLength - Number of characters to show at start (default 16)
 * @param suffixLength - Number of characters to show at end (default 8)
 * @returns Formatted string like "a1b2c3d4e5f6g7h8...12345678"
 */
export function formatFingerprint(
  fingerprint: string,
  prefixLength = 16,
  suffixLength = 8
): string {
  if (fingerprint.length <= prefixLength + suffixLength) {
    return fingerprint;
  }
  return `${fingerprint.slice(0, prefixLength)}...${fingerprint.slice(-suffixLength)}`;
}
