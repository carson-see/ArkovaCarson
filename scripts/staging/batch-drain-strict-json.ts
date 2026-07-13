/**
 * JSON ingress shared by the batch-drain evidence consumers.
 *
 * Native JSON.parse keeps the last duplicate object key. Evidence inputs must
 * reject that ambiguity lexically before the first semantic parse.
 */

function decodeJsonKey(raw: string, start: number, end: number, label: string): string {
  let decoded = '';
  for (let index = start + 1; index < end; index += 1) {
    const char = raw[index]!;
    if (char !== '\\') {
      decoded += char;
      continue;
    }
    const escaped = raw[index + 1];
    if (escaped === undefined) throw new Error(`${label} must contain valid JSON.`);
    index += 1;
    if (escaped === 'u') {
      const hex = raw.slice(index + 1, index + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`${label} must contain valid JSON.`);
      decoded += String.fromCharCode(Number.parseInt(hex, 16));
      index += 4;
      continue;
    }
    const escapes: Record<string, string> = {
      '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
    };
    if (!(escaped in escapes)) throw new Error(`${label} must contain valid JSON.`);
    decoded += escapes[escaped]!;
  }
  return decoded;
}

function assertNoDuplicateJsonKeys(raw: string, label: string): void {
  const stack: Array<{ kind: 'object'; keys: Set<string> } | { kind: 'array' }> = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === '{') { stack.push({ kind: 'object', keys: new Set() }); continue; }
    if (char === '[') { stack.push({ kind: 'array' }); continue; }
    if (char === '}' || char === ']') { stack.pop(); continue; }
    if (char !== '"') continue;

    const start = index;
    index += 1;
    for (; index < raw.length; index += 1) {
      if (raw[index] === '\\') { index += 1; continue; }
      if (raw[index] === '"') break;
    }
    if (index >= raw.length) break;
    let cursor = index + 1;
    while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
    if (raw[cursor] !== ':') continue;
    const frame = stack[stack.length - 1];
    if (!frame || frame.kind !== 'object') continue;
    const key = decodeJsonKey(raw, start, index, label);
    if (frame.keys.has(key)) throw new Error(`${label} contains duplicate JSON key ${key}.`);
    frame.keys.add(key);
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
