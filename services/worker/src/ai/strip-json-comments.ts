/**
 * Strip JavaScript-style comments from JSON strings (NMT-02)
 *
 * Nessie reasoning and DPO models sometimes output // and /* comments
 * in their JSON responses. This utility removes them before JSON.parse.
 *
 * Handles:
 * - Single-line comments: // ...
 * - Multi-line comments: /* ... * /
 * - Preserves // and /* inside quoted strings
 * - Handles escaped quotes within strings
 */

export function stripJsonComments(json: string): string {
  if (!json) return json;

  let result = '';
  let i = 0;
  const len = json.length;

  while (i < len) {
    const ch = json[i];

    // String literal — copy verbatim (respecting escapes)
    if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        const sc = json[i];
        result += sc;
        if (sc === '\\' && i + 1 < len) {
          // Escaped character — copy next char too
          i++;
          result += json[i];
        } else if (sc === '"') {
          break;
        }
        i++;
      }
      i++;
      continue;
    }

    // Single-line comment: //
    if (ch === '/' && i + 1 < len && json[i + 1] === '/') {
      // Skip until end of line
      i += 2;
      while (i < len && json[i] !== '\n') {
        i++;
      }
      continue;
    }

    // Multi-line comment: /* ... */
    if (ch === '/' && i + 1 < len && json[i + 1] === '*') {
      i += 2;
      while (i + 1 < len && !(json[i] === '*' && json[i + 1] === '/')) {
        i++;
      }
      i += 2; // skip */
      continue;
    }

    // Regular character
    result += ch;
    i++;
  }

  return result;
}
