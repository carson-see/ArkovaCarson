import { randomUUID } from 'node:crypto';

export function uniqueTestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${randomUUID()}`;
}
