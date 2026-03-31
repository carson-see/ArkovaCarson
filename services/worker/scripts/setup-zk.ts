#!/usr/bin/env node --import tsx
/**
 * VAI-02: ZK Circuit Setup Script
 *
 * Compiles the extraction-proof circom circuit and generates PLONK
 * proving/verification keys. Run once (or when circuit changes).
 *
 * Prerequisites: snarkjs, circomlib installed in services/worker
 *
 * Outputs to circuits/artifacts/:
 *   - extraction-proof.wasm (circuit WASM)
 *   - extraction-proof.r1cs (R1CS constraint system)
 *   - extraction-proof_final.zkey (PLONK proving key)
 *   - verification_key.json (PLONK verification key)
 *
 * Usage: npx tsx scripts/setup-zk.ts
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// @ts-expect-error — snarkjs has incomplete types for CLI functions
import * as snarkjs from 'snarkjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CIRCUITS_DIR = resolve(__dirname, '../circuits');
const ARTIFACTS_DIR = resolve(CIRCUITS_DIR, 'artifacts');
const CIRCUIT_SRC = resolve(CIRCUITS_DIR, 'extraction-proof.circom');

// Powers of Tau file — community-generated, universal for circuits up to 2^14 constraints
const PTAU_URL = 'https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_14.ptau';
const PTAU_FILE = resolve(ARTIFACTS_DIR, 'powersOfTau28_hez_final_14.ptau');

// Output paths
const WASM_DIR = resolve(ARTIFACTS_DIR, 'extraction-proof_js');
const R1CS_FILE = resolve(ARTIFACTS_DIR, 'extraction-proof.r1cs');
const ZKEY_FILE = resolve(ARTIFACTS_DIR, 'extraction-proof_final.zkey');
const VKEY_FILE = resolve(ARTIFACTS_DIR, 'verification_key.json');

async function main() {
  console.log('=== VAI-02: ZK Circuit Setup ===\n');

  // Ensure artifacts directory exists
  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  // Step 1: Download Powers of Tau (if not cached)
  if (!existsSync(PTAU_FILE)) {
    console.log('Step 1: Downloading Powers of Tau (14-level, ~45MB)...');
    execSync(`curl -L -o "${PTAU_FILE}" "${PTAU_URL}"`, { stdio: 'inherit' });
    console.log('  Downloaded.\n');
  } else {
    console.log('Step 1: Powers of Tau already cached.\n');
  }

  // Step 2: Compile circuit with circom
  console.log('Step 2: Compiling circom circuit...');
  if (!existsSync(CIRCUIT_SRC)) {
    throw new Error(`Circuit source not found: ${CIRCUIT_SRC}`);
  }

  // circom2 compiles to WASM + R1CS
  // --wasm: generate WASM witness calculator
  // --r1cs: generate R1CS constraint system
  // --sym: generate symbol file for debugging
  const circomBin = resolve(__dirname, '../node_modules/.bin/circom2');
  const circomCmd = existsSync(circomBin) ? circomBin : 'circom';

  execSync(
    `${circomCmd} "${CIRCUIT_SRC}" --wasm --r1cs --sym -o "${ARTIFACTS_DIR}" -l "${resolve(__dirname, '../node_modules')}"`,
    { stdio: 'inherit' },
  );
  console.log('  Compiled.\n');

  // Verify outputs exist
  const wasmFile = resolve(WASM_DIR, 'extraction-proof.wasm');
  if (!existsSync(R1CS_FILE)) {
    throw new Error(`R1CS file not generated: ${R1CS_FILE}`);
  }
  if (!existsSync(wasmFile)) {
    throw new Error(`WASM file not generated: ${wasmFile}`);
  }

  // Step 3: Generate PLONK proving key
  console.log('Step 3: Generating PLONK proving key...');
  await snarkjs.plonk.setup(R1CS_FILE, PTAU_FILE, ZKEY_FILE);
  console.log('  Proving key generated.\n');

  // Step 4: Export verification key
  console.log('Step 4: Exporting verification key...');
  const vKey = await snarkjs.zKey.exportVerificationKey(ZKEY_FILE);
  writeFileSync(VKEY_FILE, JSON.stringify(vKey, null, 2));
  console.log('  Verification key exported.\n');

  // Step 5: Print summary
  const r1csInfo = await snarkjs.r1cs.info(R1CS_FILE);
  console.log('=== Setup Complete ===');
  console.log(`  Circuit: extraction-proof.circom`);
  console.log(`  Constraints: ${r1csInfo?.nConstraints ?? 'unknown'}`);
  console.log(`  WASM: ${wasmFile}`);
  console.log(`  R1CS: ${R1CS_FILE}`);
  console.log(`  Proving key: ${ZKEY_FILE}`);
  console.log(`  Verification key: ${VKEY_FILE}`);
  console.log(`\nArtifacts ready for ZK proof generation.`);
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
