import { createHash } from 'node:crypto';

export function freezeS33Evidence<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeS33Evidence(child);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalS33EvidenceJson(value: unknown, label: string): string {
  if (Array.isArray(value)) {
    return `[${value.map((child) => (
      canonicalS33EvidenceJson(child, label)
    )).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => (
      `${JSON.stringify(key)}:${canonicalS33EvidenceJson(child, label)}`
    )).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError(`Cannot digest undefined ${label}.`);
  }
  return encoded;
}

export function digestS33Evidence(value: unknown, label: string): string {
  return `sha256:${createHash('sha256')
    .update(canonicalS33EvidenceJson(value, label))
    .digest('hex')}`;
}
