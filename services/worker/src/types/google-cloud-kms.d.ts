/**
 * Type declarations for optional @google-cloud/kms dependency.
 *
 * GCP KMS SDK is only required when KMS_PROVIDER=gcp on mainnet.
 * This declaration allows TypeScript to compile without the real package installed.
 *
 * Story: MVP-29
 */
declare module '@google-cloud/kms' {
  export class KeyManagementServiceClient {
    constructor(options?: Record<string, unknown>);
    getPublicKey(request: { name: string }): Promise<[{ pem?: string }]>;
    asymmetricSign(request: {
      name: string;
      digest: { sha256: Buffer };
    }): Promise<[{ signature?: Uint8Array }]>;
  }
}
