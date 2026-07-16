export interface B1NodeApprovalVerification {
  readonly status: 'VERIFIED';
  readonly envelopeId: string;
  readonly envelopeSha256: string;
  readonly signedPayloadSha256: string;
  readonly keyId: 'arkova.s33.b1-evidence.ed25519.v1';
  readonly verifierIdentity: 'arkova.s33.verifier.public-ed25519.v1';
  readonly payload: Record<string, unknown>;
}

export function verifyB1NodeApprovalEnvelope(
  raw: unknown,
  options?: Readonly<{
    publicKeyPem?: string;
    keyId?: string;
    fingerprint?: string;
    now?: Date;
  }>,
): B1NodeApprovalVerification;
