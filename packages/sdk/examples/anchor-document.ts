import { readFile } from 'node:fs/promises';
import { Arkova } from '@arkova/sdk';

const [, , filePath] = process.argv;

if (!filePath) {
  throw new Error('Usage: ARKOVA_API_KEY=ak_live_... tsx anchor-document.ts ./document.pdf');
}

const apiKey = process.env.ARKOVA_API_KEY;
if (!apiKey) {
  throw new Error('ARKOVA_API_KEY is required');
}

const arkova = new Arkova({ apiKey });
const bytes = await readFile(filePath);
const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const receipt = await arkova.anchor(data);

console.log(`Anchored ${filePath}`);
console.log(`Public ID: ${receipt.publicId}`);
console.log(`Fingerprint: ${receipt.fingerprint}`);
