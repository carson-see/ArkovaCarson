/**
 * VAI-02: ZK Proof Module — Zero-Knowledge Evidence Generation
 *
 * Generates and verifies PLONK zero-knowledge proofs that bind
 * AI extraction manifests to source documents without revealing
 * the document contents.
 *
 * Proof statement: "I know a document whose Poseidon hash is H,
 * and this manifest was derived from that document."
 *
 * Dependencies: snarkjs (proof gen/verify), poseidon-lite (hashing)
 * Circuit: circuits/extraction-proof.circom
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// @ts-expect-error — snarkjs has no type declarations
import * as snarkjs from 'snarkjs';
// @ts-expect-error — poseidon-lite has no type declarations
import { poseidon4, poseidon3 } from 'poseidon-lite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Circuit version — increment when circuit changes */
export const CIRCUIT_VERSION = '1.0.0';

/** Proof protocol identifier */
export const PROOF_PROTOCOL = 'plonk' as const;

// Artifact paths (relative to this file: src/ai/ → ../../circuits/artifacts/)
const ARTIFACTS_DIR = resolve(__dirname, '../../circuits/artifacts');
const WASM_PATH = resolve(ARTIFACTS_DIR, 'extraction-proof_js/extraction-proof.wasm');
const ZKEY_PATH = resolve(ARTIFACTS_DIR, 'extraction-proof_final.zkey');
const VKEY_PATH = resolve(ARTIFACTS_DIR, 'verification_key.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZkProofInput {
  /** Document data as 4 field elements (private witness) */
  documentChunks: bigint[];
  /** SHA-256 manifest hash (64-char hex) — used to compute manifest commitment */
  manifestHash: string;
}

export interface ZkProofResult {
  /** JSON-serialized PLONK proof */
  proof: unknown;
  /** Public signals: [poseidonHash, manifestCommitment] */
  publicSignals: string[];
  /** Proof protocol identifier */
  proofProtocol: typeof PROOF_PROTOCOL;
  /** Circuit version */
  circuitVersion: string;
  /** Proof generation time in milliseconds */
  generationTimeMs: number;
  /** Poseidon hash of the document (hex) */
  poseidonHash: string;
  /** Manifest commitment (hex) */
  manifestCommitment: string;
}

// ---------------------------------------------------------------------------
// Lazy-loaded artifacts (singleton — loaded once per container lifecycle)
// ---------------------------------------------------------------------------

let _vkey: unknown | null = null;

function getVerificationKey(): unknown {
  if (!_vkey) {
    if (!existsSync(VKEY_PATH)) {
      throw new Error(
        `ZK verification key not found at ${VKEY_PATH}. Run: npx tsx scripts/setup-zk.ts`,
      );
    }
    _vkey = JSON.parse(readFileSync(VKEY_PATH, 'utf-8'));
  }
  return _vkey;
}

function checkArtifactsExist(): void {
  if (!existsSync(WASM_PATH)) {
    throw new Error(
      `ZK circuit WASM not found at ${WASM_PATH}. Run: npx tsx scripts/setup-zk.ts`,
    );
  }
  if (!existsSync(ZKEY_PATH)) {
    throw new Error(
      `ZK proving key not found at ${ZKEY_PATH}. Run: npx tsx scripts/setup-zk.ts`,
    );
  }
}

// ---------------------------------------------------------------------------
// Poseidon Hash Functions
// ---------------------------------------------------------------------------

/**
 * Compute Poseidon hash of 4 document chunks.
 *
 * Poseidon is a ZK-friendly hash function (~250 constraints vs SHA-256's ~30K).
 * Returns the hash as a lowercase hex string.
 */
export function computePoseidonHash(chunks: bigint[]): string {
  if (chunks.length !== 4) {
    throw new Error(`Expected 4 document chunks, got ${chunks.length}`);
  }
  const hash: bigint = poseidon4(chunks);
  return hash.toString(16);
}

/**
 * Split a 64-character hex hash into two 128-bit field elements (hi, lo).
 *
 * Used to represent SHA-256 manifest hashes as field elements for the circuit.
 * The BN254 field supports up to ~254-bit values, so 128-bit halves fit safely.
 */
export function splitHashToFieldElements(hash: string): { hi: bigint; lo: bigint } {
  const cleaned = hash.replace(/^0x/, '').toLowerCase();
  if (cleaned.length !== 64) {
    throw new Error(`Expected 64-char hex hash, got ${cleaned.length} chars`);
  }
  const hi = BigInt('0x' + cleaned.slice(0, 32));
  const lo = BigInt('0x' + cleaned.slice(32, 64));
  return { hi, lo };
}

/**
 * Compute the manifest commitment: Poseidon(poseidonHash, manifestHashHi, manifestHashLo).
 *
 * This binds a document (via its Poseidon hash) to a specific extraction manifest
 * (via the SHA-256 manifest hash split into field elements).
 */
export function computeManifestCommitment(
  poseidonHashHex: string,
  manifestHash: string,
): string {
  const poseidonHashBigint = BigInt('0x' + poseidonHashHex);
  const { hi, lo } = splitHashToFieldElements(manifestHash);
  const commitment: bigint = poseidon3([poseidonHashBigint, hi, lo]);
  return commitment.toString(16);
}

// ---------------------------------------------------------------------------
// Proof Generation
// ---------------------------------------------------------------------------

/**
 * Generate a PLONK zero-knowledge proof binding a document to its extraction manifest.
 *
 * The proof demonstrates knowledge of document chunks whose Poseidon hash matches
 * the public input, and that the manifest commitment was correctly derived.
 *
 * Requires circuit artifacts (run setup-zk.ts first).
 *
 * @param input - Document chunks (private) and manifest hash
 * @returns Proof result with proof, public signals, and metadata
 */
export async function generateZkProof(input: ZkProofInput): Promise<ZkProofResult> {
  checkArtifactsExist();

  const startMs = Date.now();

  // Compute public inputs
  const poseidonHash = computePoseidonHash(input.documentChunks);
  const manifestCommitment = computeManifestCommitment(poseidonHash, input.manifestHash);

  // Split manifest hash into field elements for the circuit
  const { hi: manifestHashHi, lo: manifestHashLo } = splitHashToFieldElements(
    input.manifestHash,
  );

  // Build circuit input signals
  const circuitInput = {
    // Private inputs (witness)
    documentChunks: input.documentChunks.map((c) => c.toString()),
    manifestHashHi: manifestHashHi.toString(),
    manifestHashLo: manifestHashLo.toString(),
    // Public inputs
    poseidonHash: BigInt('0x' + poseidonHash).toString(),
    manifestCommitment: BigInt('0x' + manifestCommitment).toString(),
  };

  // Generate PLONK proof
  const { proof, publicSignals } = await snarkjs.plonk.fullProve(
    circuitInput,
    WASM_PATH,
    ZKEY_PATH,
  );

  const generationTimeMs = Date.now() - startMs;

  return {
    proof,
    publicSignals,
    proofProtocol: PROOF_PROTOCOL,
    circuitVersion: CIRCUIT_VERSION,
    generationTimeMs,
    poseidonHash,
    manifestCommitment,
  };
}

// ---------------------------------------------------------------------------
// Proof Verification
// ---------------------------------------------------------------------------

/**
 * Verify a PLONK zero-knowledge proof.
 *
 * Can be called without the private witness — only needs the proof and public signals.
 * Suitable for server-side verification and (in future) browser WASM verification.
 *
 * @param proof - The PLONK proof object
 * @param publicSignals - Public signals [poseidonHash, manifestCommitment]
 * @returns true if the proof is valid
 */
export async function verifyZkProof(
  proof: unknown,
  publicSignals: string[],
): Promise<boolean> {
  const vkey = getVerificationKey();

  try {
    const valid: boolean = await snarkjs.plonk.verify(vkey, publicSignals, proof as snarkjs.PlonkProof);
    return valid;
  } catch {
    // Invalid proof format or verification error
    return false;
  }
}

/** Reset cached verification key — for testing only */
export function _resetVkeyCache(): void {
  _vkey = null;
}
