/**
 * Recovery Phrase Generation (Task SCRUM-IDT-TASK4)
 *
 * Generates a 12-word recovery phrase entirely client-side using
 * window.crypto.getRandomValues. The phrase is NEVER sent to the server.
 *
 * Architecture:
 *  - 128-word curated English wordlist (7 bits per word)
 *  - 12 words = 84 bits of entropy (sufficient for profile claim keys)
 *  - SHA-256 of the canonical phrase stored as claim_key_hash on activation
 *
 * Constitution 1.6: client-side processing only — no phrase content leaves the device.
 */

// 128-word curated wordlist (7 bits / word → 12 × 7 = 84 bits entropy)
const WORDLIST: readonly string[] = [
  'able', 'above', 'actor', 'admit', 'adopt', 'agent', 'agree', 'allow',
  'alone', 'alter', 'among', 'ample', 'angle', 'apple', 'apply', 'arch',
  'arise', 'armor', 'array', 'arrow', 'asset', 'atlas', 'audio', 'aware',
  'basic', 'begin', 'bench', 'blade', 'blank', 'blend', 'blink', 'bloom',
  'board', 'bonus', 'boost', 'bound', 'brain', 'brave', 'break', 'breed',
  'brick', 'brief', 'bring', 'broad', 'brush', 'build', 'bulge', 'burst',
  'cabin', 'cable', 'carry', 'catch', 'cause', 'chain', 'chalk', 'chart',
  'chase', 'chief', 'class', 'clean', 'clear', 'climb', 'clock', 'cloud',
  'coach', 'coast', 'color', 'cross', 'crowd', 'crown', 'curve', 'cycle',
  'daily', 'dance', 'debug', 'depth', 'derby', 'digit', 'diver', 'draft',
  'drive', 'drone', 'dunes', 'early', 'earth', 'eight', 'elite', 'ember',
  'enjoy', 'epoch', 'equal', 'event', 'excel', 'exist', 'extra', 'fable',
  'facet', 'faint', 'faith', 'field', 'fifth', 'fixed', 'flame', 'flash',
  'fleet', 'float', 'floor', 'focus', 'force', 'forge', 'forth', 'forum',
  'found', 'frame', 'fresh', 'front', 'frost', 'fruit', 'gauge', 'giant',
  'given', 'glade', 'glyph', 'grace', 'grade', 'grain', 'grand', 'grant',
] as const;

/**
 * Generate a 12-word recovery phrase using cryptographically secure randomness.
 * All randomness comes from window.crypto.getRandomValues — never server-side.
 */
export function generateRecoveryPhrase(): string[] {
  const wordCount = 12;
  const randomBytes = new Uint8Array(wordCount);
  window.crypto.getRandomValues(randomBytes);

  return Array.from(randomBytes).map((byte) => {
    // Modulo 128 to index into our 128-word list (7 bits of each byte)
    return WORDLIST[byte % WORDLIST.length];
  });
}

/**
 * Derive a SHA-256 commitment hash from a recovery phrase.
 * Used as a claim_key_hash stored at activation time (proves the user
 * generated and saved the phrase without storing the phrase itself).
 *
 * Constitution 1.6: only the hash is sent to the server, never the words.
 */
export async function deriveClaimKeyHash(words: string[]): Promise<string> {
  const canonical = words.join(' ').toLowerCase().trim();
  const encoder = new TextEncoder();
  const data = encoder.encode('arkova-claim-v1:' + canonical);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Format words for display — returns "word1 word2 word3 ..." with visual grouping.
 */
export function formatPhraseForDisplay(words: string[]): string {
  return words.join(' ');
}
