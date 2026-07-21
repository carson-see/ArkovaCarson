export interface G1Scope {
  readonly rigClass: 'RIG-G1';
  readonly rigName: string;
  readonly rigProfile: 'gemini';
  readonly soakId: string;
  readonly rigId: 'RIG-G1';
  readonly leaseId: string;
  readonly corpusDigest: string;
  readonly endpointId: '6072023465';
  readonly endpointResource: 'projects/arkova1/locations/us-central1/endpoints/6072023465';
  readonly endpointDisplayName: 'arkova-s33-rig-g1-b-tuned-v6';
  readonly vertexModelResource: 'projects/270018525501/locations/us-central1/models/6611494259700793344@1';
  readonly checkpointId: '6';
  readonly deployedModelId: '6072023467';
  readonly deployedModelDisplayName: 'arkova-s33-rig-g1-b-tuned-v6';
  readonly deploymentResourcesMode: 'TUNED_GEMINI_AUTOMATIC_RESOURCES';
  readonly minReplicaCount: 1;
  readonly maxReplicaCount: 1;
  readonly controlRuntimeServiceAccount: 's33-rig-g1-a-runtime@arkova1.iam.gserviceaccount.com';
  readonly tunedRuntimeServiceAccount: 's33-rig-g1-b-runtime@arkova1.iam.gserviceaccount.com';
  readonly controlService: string;
  readonly tunedService: string;
  readonly controlProjectName: string;
  readonly tunedProjectName: string;
  readonly controlSupabaseUrlSecret: 'supabase-url-s33-g1-a-staging@1';
  readonly controlSupabaseServiceRoleSecret: 'supabase-service-role-key-s33-g1-a-staging@1';
  readonly tunedSupabaseUrlSecret: 'supabase-url-s33-g1-b-staging@1';
  readonly tunedSupabaseServiceRoleSecret: 'supabase-service-role-key-s33-g1-b-staging@1';
  readonly controlRunId: string;
  readonly tunedRunId: string;
  readonly controlQueue: string;
  readonly tunedQueue: string;
  readonly pairedCadenceMaxMin: number;
  readonly secretReferences: {
    readonly stripeSecretKey: 'stripe-secret-key-staging@1';
    readonly stripeWebhookSecret: 'stripe-webhook-secret-staging@1';
    readonly apiKeyHmacSecret: 'api-key-hmac-secret-staging@1';
    readonly cronSecret: 'cron-secret@1';
    readonly geminiApiKey: 'gemini-api-key@2';
  };
  readonly immutableLedger: {
    readonly backend: string;
    readonly bucket: string;
    readonly projectId: string;
    readonly requiresPerObjectRetention: boolean;
  };
}

export interface G1SpendApprovalRecord {
  readonly schemaVersion: 1;
  readonly approvalId: string;
  readonly sourceReference: string;
  readonly immutableRevisionId: string;
  readonly authority: {
    readonly approverIdentity: string;
    readonly approverRole: 'founder' | 'cto';
    readonly authorizedRosterRootSha256: string;
  };
  readonly candidate: { readonly sourceHeadSha: string; readonly imageDigest: string };
  readonly scope: G1Scope;
  readonly budget: {
    readonly isolatedSupabaseProjectCount: 4;
    readonly isolatedSupabaseProjectMonthlyEachUsd: 10;
    readonly isolatedSupabaseProjectsMonthlyTotalUsd: 40;
    readonly g1VariableComputeModelCapUsd: number;
    readonly s33TotalCapUsd: number;
  };
  readonly execution: { readonly ownerIdentity: string; readonly expiresAt: string };
  readonly raci: {
    readonly responsibleIdentity: string;
    readonly accountableIdentity: string;
    readonly consultedIdentities: readonly string[];
    readonly informedIdentities: readonly string[];
  };
  readonly verification: {
    readonly verifiedAt: string;
    readonly verifierIdentity: string;
    readonly method: 'ed25519-pinned-authority-roster';
  };
}

export interface G1ExpectedCandidate extends G1Scope {
  readonly sourceHeadSha: string;
  readonly imageDigest: string;
}

export interface VerifiedG1SpendApproval {
  readonly status: 'VERIFIED';
  readonly approvalId: string;
  readonly sourceReference: string;
  readonly immutableRevisionId: string;
  readonly canonicalSha256: string;
  readonly approverIdentity: string;
  readonly approverRole: 'founder' | 'cto';
  readonly authorityRosterRootSha256: string;
  readonly candidateSourceHeadSha: string;
  readonly candidateImageDigest: string;
  readonly scope: G1Scope;
  readonly isolatedSupabaseProjectCount: 4;
  readonly isolatedSupabaseProjectMonthlyEachUsd: 10;
  readonly isolatedSupabaseProjectsMonthlyTotalUsd: 40;
  readonly g1VariableComputeModelCapUsd: number;
  readonly s33TotalCapUsd: number;
  readonly ownerIdentity: string;
  readonly expiresAt: string;
  readonly raci: {
    readonly responsibleIdentity: string;
    readonly accountableIdentity: string;
    readonly consultedIdentities: readonly string[];
    readonly informedIdentities: readonly string[];
  };
  readonly approvalVerifiedAt: string;
  readonly verifierIdentity: string;
  readonly verificationMethod: 'ed25519-pinned-authority-roster';
  readonly runtimeVerifiedAt: string;
  readonly trustRootKeyId: string;
  readonly trustRootKeyFingerprint: string;
  readonly authorityActivatedAtUtc: string;
}

export interface VerifierConfig {
  readonly publicKeyPem: string;
  readonly keyId: string;
  readonly keyFingerprint: string;
  readonly authorityRosterRootSha256: string;
  readonly authorizedApproverIdentities: readonly string[];
  readonly verifierIdentity: string;
  readonly activatedAtUtc: string;
}

export interface G1SpendApprovalAuthority {
  readonly keyId: 'arkova.s33.g1-spend.ed25519.v1';
  readonly purpose: 'G1_SPEND';
  readonly publicKeyFingerprintSha256: string;
  readonly authorizedApproverIdentities: readonly string[];
  readonly verifierIdentity: string;
  readonly activatedAtUtc: string;
  readonly genesisRosterRootSha256: string;
}

export interface G1SpendApprovalVerifier {
  verify(rawEnvelope: string, expected: G1ExpectedCandidate, now?: Date): VerifiedG1SpendApproval;
}

export const g1SpendApprovalRecordSchema: {
  parse(value: unknown): G1SpendApprovalRecord;
};
export function canonicalApprovalRecordSha256(record: G1SpendApprovalRecord): string;
export function createProductionG1SpendApprovalVerifier(): G1SpendApprovalVerifier;
export function getG1SpendApprovalAuthority(): G1SpendApprovalAuthority;
export function createG1SpendApprovalVerifierForTest(config: VerifierConfig): G1SpendApprovalVerifier;
