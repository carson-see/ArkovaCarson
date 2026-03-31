/**
 * VAI-02: Extraction Proof Circuit
 *
 * Proves knowledge of a document whose Poseidon hash matches the public input,
 * and that the manifest commitment is correctly derived from the document hash
 * and manifest hash components — WITHOUT revealing the document contents.
 *
 * Public inputs:
 *   - poseidonHash: Poseidon hash of document chunks
 *   - manifestCommitment: Poseidon(poseidonHash, manifestHashHi, manifestHashLo)
 *
 * Private inputs:
 *   - documentChunks[4]: Document data as field elements
 *   - manifestHashHi: Upper 128 bits of SHA-256 manifest hash
 *   - manifestHashLo: Lower 128 bits of SHA-256 manifest hash
 *
 * Constraints: ~500 total (2x Poseidon + equality checks)
 */
pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

template ExtractionProof() {
    // === Private inputs (witness — never revealed) ===
    signal input documentChunks[4];    // Document data split into 4 field elements
    signal input manifestHashHi;       // Upper 128 bits of manifest SHA-256 hash
    signal input manifestHashLo;       // Lower 128 bits of manifest SHA-256 hash

    // === Public inputs (statement — visible to verifier) ===
    signal input poseidonHash;         // Claimed Poseidon hash of document
    signal input manifestCommitment;   // Claimed commitment binding doc to manifest

    // === Constraint 1: Document hash preimage ===
    // Prove: Poseidon(documentChunks) === poseidonHash
    component docHasher = Poseidon(4);
    docHasher.inputs[0] <== documentChunks[0];
    docHasher.inputs[1] <== documentChunks[1];
    docHasher.inputs[2] <== documentChunks[2];
    docHasher.inputs[3] <== documentChunks[3];

    docHasher.out === poseidonHash;

    // === Constraint 2: Manifest binding ===
    // Prove: Poseidon(poseidonHash, manifestHashHi, manifestHashLo) === manifestCommitment
    // This binds the document to a specific extraction manifest without
    // revealing the manifest hash or document contents.
    component manifestBinder = Poseidon(3);
    manifestBinder.inputs[0] <== poseidonHash;
    manifestBinder.inputs[1] <== manifestHashHi;
    manifestBinder.inputs[2] <== manifestHashLo;

    manifestBinder.out === manifestCommitment;
}

component main {public [poseidonHash, manifestCommitment]} = ExtractionProof();
