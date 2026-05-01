const PUBLIC_ATTESTATION_KEYS = [
  'public_id',
  'attestation_type',
  'status',
  'subject_type',
  'subject_identifier',
  'attester_name',
  'attester_type',
  'summary',
  'issued_at',
  'expires_at',
  'created_at',
  'fingerprint',
  'chain_tx_id',
] as const;

export function toPublicAttestation<T extends Record<string, unknown>>(row: T | null | undefined): Partial<T> {
  if (!row) return {};
  const sanitized: Record<string, unknown> = {};
  for (const key of PUBLIC_ATTESTATION_KEYS) {
    if (key in row) sanitized[key] = row[key];
  }
  return sanitized as Partial<T>;
}
