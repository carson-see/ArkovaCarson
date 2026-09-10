/**
 * Publish the network-observed time, matching get_public_anchor()'s
 * status NOT IN ('PENDING') gate (SCRUM-4517). Never substitute created_at.
 * Optional API fields omit null; nullable contracts return it unchanged.
 */
export function publicAnchorTimestamp(
  status: string | null | undefined,
  chainTimestamp: string | null | undefined,
): string | null {
  if (!status || status === 'PENDING') return null;
  return chainTimestamp ?? null;
}
