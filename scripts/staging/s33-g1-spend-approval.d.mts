export interface G1Scope {
  readonly rigClass: 'RIG-G1';
  readonly rigName: string;
  readonly rigProfile: 'gemini';
  readonly soakId: string;
  readonly rigId: 'RIG-G1';
  readonly leaseId: string;
  readonly corpusDigest: string;
  readonly endpointResource: string;
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
    readonly isolatedSupabaseProjectCount: 3;
    readonly isolatedSupabaseProjectMonthlyEachUsd: 10;
    readonly isolatedSupabaseProjectsMonthlyTotalUsd: 30;
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
  readonly isolatedSupabaseProjectCount: 3;
  readonly isolatedSupabaseProjectMonthlyEachUsd: 10;
  readonly isolatedSupabaseProjectsMonthlyTotalUsd: 30;
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
  readonly trustRootKeyFingerprint: string;
}

export interface VerifierConfig {
  readonly publicKeyPem: string;
  readonly keyFingerprint: string;
  readonly authorityRosterRootSha256: string;
  readonly authorizedApproverIdentities: readonly string[];
  readonly verifierIdentity: string;
}

export interface G1SpendApprovalVerifier {
  verify(rawEnvelope: string, expected: G1ExpectedCandidate, now?: Date): VerifiedG1SpendApproval;
}

export const g1SpendApprovalRecordSchema: {
  parse(value: unknown): G1SpendApprovalRecord;
};
export function canonicalApprovalRecordSha256(record: G1SpendApprovalRecord): string;
export function createProductionG1SpendApprovalVerifier(): G1SpendApprovalVerifier;
export function createG1SpendApprovalVerifierForTest(config: VerifierConfig): G1SpendApprovalVerifier;
