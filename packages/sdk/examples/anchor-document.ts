import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Arkova } from '@carsonarkova/sdk';

const [, , filePathArg] = process.argv;

if (!filePathArg) {
  throw new Error('Usage: ARKOVA_API_KEY=ak_live_... tsx anchor-document.ts ./document.pdf');
}

const apiKey = process.env.ARKOVA_API_KEY;
if (!apiKey) {
  throw new Error('ARKOVA_API_KEY is required');
}

// Resolve to an absolute path so the log lines below are unambiguous, and fail
// with a clear message rather than a raw EISDIR/ENOENT from readFile.
//
// Deliberately NOT sandboxed to the working directory: the argument is argv of
// a CLI the user invoked themselves, so there is no trust boundary to enforce
// here — `anchor-document.ts /Users/me/contract.pdf` is ordinary usage, and
// rejecting it would only break the example for the consumers who copy it.
const filePath = resolve(filePathArg);

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
