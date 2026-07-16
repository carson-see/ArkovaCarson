export interface RigRProvisionApprovalRecord {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly sourceReference: string;
  readonly immutableRevisionId: string;
  readonly authority: Readonly<Record<string, unknown>>;
  readonly candidate: Readonly<Record<string, unknown>>;
  readonly topology: Readonly<Record<string, unknown>>;
  readonly execution: Readonly<Record<string, unknown>>;
  readonly budget: Readonly<Record<string, unknown>>;
  readonly teardown: Readonly<Record<string, unknown>>;
  readonly verification: Readonly<Record<string, unknown>>;
}

export interface RigRProvisionExpectedBinding {
  readonly sourceHeadSha: string;
  readonly sourceTreeSha: string;
  readonly sourceHeadImageRef: string;
  readonly imageDigest: string;
  readonly provisionArtifactSha256: string;
  readonly rigName: string;
  readonly rigProfile: string;
  readonly soakId: string;
  readonly leaseId: string;
  readonly requiredWallMin: number;
  readonly vertexEndpoint: string;
  readonly vertexModel: string;
  readonly deployedModelId: string;
  readonly provisionStartedAt: string;
  readonly expiresAt: string;
  readonly teardownScriptSha256: string;
  readonly secretReferences: {
    readonly supabaseUrl: string;
    readonly supabaseServiceRoleKey: string;
    readonly stripeSecretKey: string;
    readonly stripeWebhookSecret: string;
    readonly apiKeyHmacSecret: string;
    readonly cronSecret: string;
    readonly geminiApiKey: string;
  };
  readonly immutableLedger: {
    readonly backend: string;
    readonly bucket: string;
    readonly projectId: string;
    readonly requiresPerObjectRetention: boolean;
  };
}

export interface RigRProvisionApprovalVerifierConfig {
  readonly publicKeyPem: string;
  readonly keyId: string;
  readonly keyFingerprint: string;
  readonly authorityRosterRootSha256: string;
  readonly authorizedApproverIdentity: string;
  readonly verifierIdentity: string;
  readonly operatorIdentity: string;
  readonly activatedAtUtc: string;
}

export interface RigRProvisionApprovalAuthority {
  readonly keyId: 'arkova.s33.release-corpus.ed25519.v1';
  readonly purpose: 'RIG_R_PROVISION';
  readonly publicKeyFingerprintSha256: string;
  readonly authorizedApproverIdentity: string;
  readonly verifierIdentity: string;
  readonly authorizedOperator: string;
  readonly activatedAtUtc: string;
  readonly genesisRosterRootSha256: string;
}

export interface RigRProvisionApprovalVerifier {
  verify(
    rawEnvelope: string,
    expected: RigRProvisionExpectedBinding,
    now?: Date,
  ): Readonly<Record<string, unknown>>;
}

export const RIG_R_PROVISION_APPROVAL_SIGNATURE_DOMAIN: string;
export const rigRProvisionApprovalRecordSchema: {
  parse(value: unknown): RigRProvisionApprovalRecord;
};
export function canonicalRigRProvisionApprovalRecordSha256(record: unknown): string;
export function getRigRProvisionApprovalAuthority(): RigRProvisionApprovalAuthority;
export function createProductionRigRProvisionApprovalVerifier(): RigRProvisionApprovalVerifier;
export function createRigRProvisionApprovalVerifierForTest(
  config: RigRProvisionApprovalVerifierConfig,
): RigRProvisionApprovalVerifier;
