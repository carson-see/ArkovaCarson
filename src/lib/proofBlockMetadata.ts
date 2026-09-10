interface BlockMetadata {
  hash?: string | null;
  height?: number | null;
  timestamp?: string | null;
}

/**
 * Anchor metadata can repair a proof only when both identify the same block.
 * A known mismatch withholds the packet; an unknown identity retains only the
 * proof row's existing metadata, without claiming a new measurement for it.
 */
export function resolveProofBlockMetadata(anchor: BlockMetadata, proof: BlockMetadata) {
  const normalizedHash = (value: string | null | undefined) =>
    typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
  const anchorHash = normalizedHash(anchor.hash);
  const proofHash = normalizedHash(proof.hash);
  if (anchorHash && proofHash && anchorHash !== proofHash) return null;

  const validHeight = (height: number | null | undefined) =>
    typeof height === 'number' && Number.isSafeInteger(height) && height >= 0 ? height : null;
  const anchorHeight = validHeight(anchor.height);
  const proofHeight = validHeight(proof.height);
  const source = anchorHash && anchorHash === proofHash ? 'anchor' : 'proof';
  return {
    source,
    height: source === 'anchor' ? anchorHeight ?? proofHeight : proofHeight,
    timestamp: source === 'anchor' ? anchor.timestamp ?? proof.timestamp ?? null : proof.timestamp ?? null,
  };
}
