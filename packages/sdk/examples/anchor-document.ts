import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Arkova } from '@carsonarkova/sdk';

const [, , filePathArg] = process.argv;

if (!filePathArg) {
  throw new Error('Usage: ARKOVA_API_KEY=ak_live_... tsx anchor-document.ts ./document.pdf');
}

const apiKey = process.env.ARKOVA_API_KEY;
if (!apiKey) {
  throw new Error('ARKOVA_API_KEY is required');
}

// Canonicalize the CLI-supplied path, then validate it before it ever reaches
// the filesystem — this is an example script consumers copy/paste (and that
// AI coding agents run with arguments they generated themselves), so a typo'd
// or crafted `filePathArg` must not be able to walk outside the working
// directory the script was invoked from. `path.relative()` returning a `..`-
// prefixed or absolute result means the resolved path escaped `baseDir`.
const baseDir = process.cwd();
const filePath = resolve(baseDir, filePathArg);
const relativeToBase = relative(baseDir, filePath);
if (relativeToBase.startsWith('..') || isAbsolute(relativeToBase)) {
  throw new Error(`Refusing to read a path outside the current working directory: ${filePath}`);
}

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
