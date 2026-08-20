import { readFile, stat } from 'node:fs/promises';
import { Arkova } from 'arkova';

const [, , filePath] = process.argv;

if (!filePath) {
  throw new Error('Usage: ARKOVA_API_KEY=ak_live_... tsx anchor-document.ts ./document.pdf');
}

const apiKey = process.env.ARKOVA_API_KEY;
if (!apiKey) {
  throw new Error('ARKOVA_API_KEY is required');
}

// The path is used exactly as given, so absolute, relative and shell-expanded
// `~` paths all work — `tsx anchor-document.ts /Users/me/contract.pdf` is the
// ordinary way to run this, and this file ships inside the npm tarball, so it
// is the first thing consumers copy.
//
// There is deliberately NO working-directory sandbox here. The argument is
// argv of a CLI the user invoked themselves; there is no trust boundary
// between the caller and the path, so confining it protects nobody.
//
// SonarCloud raises tssecurity:S8707 ("Agentic workflows should not be
// vulnerable to path injection") on the two filesystem calls below, because
// its taint model treats `process.argv` as LLM-controlled. That rule's only
// compliant shape is confinement to a base directory — precisely the
// behaviour this example must not have. The findings are dispositioned in
// SonarCloud rather than coded around; see the S8707 entry under KNOWN FALSE
// POSITIVES in `.sonarcloud.properties`.
//
// Do not re-add a cwd jail here. It was tried on 2026-08-02 and reverted: it
// made `anchor-document.ts /Users/me/contract.pdf` throw.
const fileStat = await stat(filePath);
if (!fileStat.isFile()) {
  throw new Error(`Not a regular file: ${filePath}`);
}

const arkova = new Arkova({ apiKey });
const bytes = await readFile(filePath);
const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const receipt = await arkova.anchor(data);

console.log(`Anchored ${filePath}`);
console.log(`Public ID: ${receipt.publicId}`);
console.log(`Fingerprint: ${receipt.fingerprint}`);
