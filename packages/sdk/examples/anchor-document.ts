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

// Resolve the CLI-supplied path to an absolute path and confirm it's a real,
// regular file before touching the filesystem — guards against a mistyped or
// crafted argument (directory, device file, or unintended location) rather
// than trusting process.argv directly.
const filePath = resolve(process.cwd(), filePathArg);
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
