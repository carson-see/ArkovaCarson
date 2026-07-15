/**
 * JSON ingress shared by the batch-drain evidence consumers.
 *
 * Native JSON.parse keeps the last duplicate object key. Evidence inputs must
 * reject that ambiguity lexically before the first semantic parse.
 */

function decodeJsonKey(raw: string, start: number, end: number, label: string): string {
  let decoded = '';
  let index = start + 1;
  while (index < end) {
    const char = raw[index]!;
    if (char !== '\\') {
      decoded += char;
      index += 1;
      continue;
    }
    const escaped = raw[index + 1];
    if (escaped === undefined) throw new Error(`${label} must contain valid JSON.`);
    if (escaped === 'u') {
      const hex = raw.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`${label} must contain valid JSON.`);
      // JSON \u escapes are UTF-16 code units. Surrogate pairs must remain two
      // units here so semantic duplicate keys match JSON.parse exactly.
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 6;
      continue;
    }
    const escapes: Record<string, string> = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    };
    if (!(escaped in escapes)) throw new Error(`${label} must contain valid JSON.`);
    decoded += escapes[escaped]!;
    index += 2;
  }
  return decoded;
}

interface ScannedJsonString {
  end: number;
  followedByColon: boolean;
}

type JsonContainerFrame = { kind: 'object'; keys: Set<string> } | { kind: 'array' };

function scanJsonString(raw: string, start: number): ScannedJsonString {
  let end = start + 1;
  while (end < raw.length) {
    if (raw[end] === '\\') {
      end += 2;
      continue;
    }
    if (raw[end] === '"') break;
    end += 1;
  }
  if (end >= raw.length) return { end: raw.length, followedByColon: false };

  let cursor = end + 1;
  while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
  return { end, followedByColon: raw[cursor] === ':' };
}

function recordObjectKey(
  frame: JsonContainerFrame | undefined,
  raw: string,
  start: number,
  end: number,
  label: string,
): void {
  if (frame?.kind !== 'object') return;
  const key = decodeJsonKey(raw, start, end, label);
  if (frame.keys.has(key)) throw new Error(`${label} contains duplicate JSON key ${key}.`);
  frame.keys.add(key);
}

function assertNoDuplicateJsonKeys(raw: string, label: string): void {
  const stack: JsonContainerFrame[] = [];
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === '{') {
      stack.push({ kind: 'object', keys: new Set() });
      index += 1;
      continue;
    }
    if (char === '[') {
      stack.push({ kind: 'array' });
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      stack.pop();
      index += 1;
      continue;
    }
    if (char !== '"') {
      index += 1;
      continue;
    }

    const start = index;
    const scanned = scanJsonString(raw, start);
    index = scanned.end + 1;
    if (!scanned.followedByColon) continue;
    recordObjectKey(stack[stack.length - 1], raw, start, scanned.end, label);
  }
}

export function parseJsonRejectingDuplicateKeys(raw: unknown, label: string): unknown {
  if (typeof raw !== 'string') throw new Error(`${label} must be a primitive string.`);
  assertNoDuplicateJsonKeys(raw, label);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}
