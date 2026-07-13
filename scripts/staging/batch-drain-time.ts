import { z } from 'zod';

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!RFC3339_UTC.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const roundTrip = new Date(milliseconds).toISOString();
  return value.includes('.') ? roundTrip === value : roundTrip.replace('.000Z', 'Z') === value;
}

export const strictUtcTimestampSchema = z.string().refine(
  isCanonicalUtcTimestamp,
  'timestamp must be canonical RFC3339 UTC (YYYY-MM-DDTHH:mm:ss[.SSS]Z)',
);

export function parseUtcTimestamp(value: string, label: string): number {
  if (!isCanonicalUtcTimestamp(value)) {
    throw new Error(`${label} must be canonical RFC3339 UTC (YYYY-MM-DDTHH:mm:ss[.SSS]Z).`);
  }
  return Date.parse(value);
}
