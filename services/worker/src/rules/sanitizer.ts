/**
 * Prompt-Injection Input Sanitizer (SEC-02 — SCRUM-1026)
 *
 * ARK-110 ships a `POST /api/v1/rules/draft` endpoint that feeds user-typed
 * natural language into Gemini. Without a sanitizer, an attacker can:
 *   - inject "ignore previous instructions" strings to subvert the system prompt
 *   - smuggle zero-width / homoglyph / RTL-override chars that look harmless
 *     on the screen but re-shape the prompt
 *   - submit huge emoji floods that blow the token budget
 *
 * This file is the pure sanitizer layer. It normalizes, strips control
 * characters, caps length, and returns structured warnings. The Gemini call
 * lives in the draft endpoint — this module is trivially unit-testable with
 * no I/O and can be reused by future AI features.
 */

const MAX_INPUT_CHARS = 1000;

/** Control characters allowed through — newline + tab keep plain prose intact. */
const CONTROL_CHAR_ALLOWLIST = new Set(['\n', '\t']);

/**
 * Zero-width and bidi-override characters. These render invisibly but can
 * change the meaning of a prompt (e.g. RTL override flips instruction order).
 */
const INVISIBLE_CODEPOINTS = new Set<number>([
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0x2060, // word joiner
  0xfeff, // BOM / zero-width no-break space
  0x202a, // LRE
  0x202b, // RLE
  0x202c, // PDF
  0x202d, // LRO
  0x202e, // RLO (RTL override)
  0x2066, // LRI
  0x2067, // RLI
  0x2068, // FSI
  0x2069, // PDI
]);

/**
 * Substrings that suggest a jailbreak attempt. Finding one is NOT a hard
 * reject — the Gemini system prompt + Zod output validation are the real
 * defenses. This just surfaces a warning the caller can attach to the draft.
 */
const JAILBREAK_PATTERNS: RegExp[] = [
  /ignore (?:all )?(?:previous|prior|above) (?:instructions?|rules?|prompts?)/i,
  /disregard (?:the )?(?:system|above) prompt/i,
  /you are (?:now )?(?:(?:an?|the) )?(?:dan|developer|admin|god)\b/i,
  /jailbreak|prompt[- ]?injection/i,
  /###\s*(?:system|assistant|user)\s*:/i,
  /\benable\s*=\s*true\b/i,
];

export interface SanitizerResult {
  /** Cleaned text safe to embed in a prompt. */
  clean: string;
  /** Original length in grapheme clusters (approx — uses code points). */
  originalLength: number;
  /** Length of `clean`. */
  cleanLength: number;
  /** Non-blocking warnings for the admin. */
  warnings: string[];
  /**
   * Blocking reason: the input is unsafe and should NOT be fed to Gemini.
   * When set, caller should 422 the draft request.
   */
  rejection?: 'too_long' | 'empty' | 'emoji_flood' | 'all_invisible';
}

export function sanitizeRuleDraftInput(input: string): SanitizerResult {
  const warnings: string[] = [];

  // 1. Unicode NFC normalization — canonicalize homoglyph variants where
  //    the codepoint has a canonical form. Doesn't catch Cyrillic-а vs
  //    Latin-a style spoofing; we flag that separately below.
  const normalized = typeof input === 'string' ? input.normalize('NFC') : '';
  const originalLength = [...normalized].length;

  if (originalLength === 0) {
    return {
      clean: '',
      originalLength: 0,
      cleanLength: 0,
      warnings,
      rejection: 'empty',
    };
  }
  if (originalLength > MAX_INPUT_CHARS) {
    return {
      clean: '',
      originalLength,
      cleanLength: 0,
      warnings,
      rejection: 'too_long',
    };
  }

  // 2. Strip control characters (except \n and \t) and invisible codepoints.
  let strippedInvisible = 0;
  let strippedControl = 0;
  const out: string[] = [];
  for (const ch of normalized) {
    const cp = ch.codePointAt(0)!;
    if (INVISIBLE_CODEPOINTS.has(cp)) {
      strippedInvisible += 1;
      continue;
    }
    // ASCII control range 0x00-0x1F except \n (0x0A) and \t (0x09), plus DEL and C1
    if ((cp < 0x20 && !CONTROL_CHAR_ALLOWLIST.has(ch)) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      strippedControl += 1;
      continue;
    }
    out.push(ch);
  }
  if (strippedInvisible > 0) {
    warnings.push(`stripped ${strippedInvisible} invisible / bidi override character(s)`);
  }
  if (strippedControl > 0) {
    warnings.push(`stripped ${strippedControl} control character(s)`);
  }

  const clean = out.join('');
  const cleanLength = [...clean].length;

  if (cleanLength === 0) {
    return {
      clean,
      originalLength,
      cleanLength,
      warnings,
      rejection: 'all_invisible',
    };
  }

  // 3. Non-BMP flood guard — emoji-heavy inputs inflate token count with
  //    no meaningful signal. Reject > 50% non-BMP.
  let nonBmp = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0)!;
    if (cp > 0xffff) nonBmp += 1;
  }
  if (nonBmp * 2 > cleanLength) {
    return {
      clean,
      originalLength,
      cleanLength,
      warnings,
      rejection: 'emoji_flood',
    };
  }

  // 4. Surface-level jailbreak heuristics — informational.
  for (const pattern of JAILBREAK_PATTERNS) {
    if (pattern.test(clean)) {
      warnings.push('input contains instruction-override language — treating as prose');
      break;
    }
  }

  // 5. Homoglyph-ish warning: if input mixes Cyrillic + Latin in the same
  //    alphabetic run, flag. Cheap heuristic using Unicode property escapes.
  if (
    /[A-Za-z].*[\p{Script=Cyrillic}]|[\p{Script=Cyrillic}].*[A-Za-z]/u.test(clean)
  ) {
    warnings.push('input mixes Latin and Cyrillic letters — possible spoofing');
  }

  return { clean, originalLength, cleanLength, warnings };
}
