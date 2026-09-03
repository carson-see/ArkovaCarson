/**
 * Non-secret random helpers — SonarCloud typescript:S2245 (SCRUM-3167 batch
 * item 25). `Math.random()` trips Sonar's "insecure PRNG" security rating
 * even for uses (a friendly-name uniqueness suffix, never a token or key)
 * that don't need cryptographic unpredictability. Using a real CSPRNG here
 * costs nothing and keeps `new_security_rating` at a passing grade.
 */

/**
 * Return `byteLength` random bytes as a lowercase hex string (2 characters
 * per byte). Not a secret — only needs to make a friendly name unique
 * enough to avoid a same-day collision (`MfaEnrollmentRequired.tsx`'s
 * default enrollment name, `TwoFactorSetup.tsx`'s default factor name).
 */
export function randomSuffixHex(byteLength: number = 2): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
