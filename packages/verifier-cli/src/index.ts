/**
 * @arkova/verifier-cli — public library surface.
 *
 * Standalone reference verifier for Arkova proof packets. Recomputes the
 * on-chain Merkle root with the same canonical routine the server uses and
 * confirms inclusion against an INDEPENDENT node by delegating to
 * `@arkova/verifier` — zero Arkova network calls, one shared on-chain routine.
 */

export { verifyProof } from './verify.js';
export type { VerifyReport, VerifyStep, VerifyOptions, StepStatus } from './verify.js';
export { renderReport } from './lib/report.js';
export { assertIndependentEndpoint, DEFAULT_ESPLORA } from './lib/independent-endpoint.js';
export { verifyBundleSignature } from './lib/signature.js';
export type { SignatureResult } from './lib/signature.js';
export { verifyMerkleInclusion } from './vendor/merkle-verify.js';
// Fixture-corpus plumbing shared by the test helpers and the parity comparator.
export { fixtureNodeFetch, packetFromProof08Vector, resolveProof08Vector } from './lib/fixtures.js';
export type { Proof08Corpus, Proof08Vector } from './lib/fixtures.js';
// Re-export the shared on-chain confirmation surface from @arkova/verifier so
// consumers of this library use the SAME routine the CLI does (no second decoder).
export { confirmInclusion, createEsploraFetch } from '@arkova/verifier';
export type {
  ConfirmInclusionRequest,
  ConfirmInclusionResult,
  ConfirmInclusionStatus,
  IndependentNodeFetch,
  EsploraTx,
} from '@arkova/verifier';
export type {
  IndependentNode,
  ProofPacket,
  SignedProofBundle,
  MerkleProofEntry,
  VerifierFixture,
  FixtureNodeResponses,
} from './types.js';
