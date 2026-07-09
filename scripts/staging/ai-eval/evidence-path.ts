import { isAbsolute, relative, resolve, sep } from 'node:path';

const EVIDENCE_ROOT = resolve(process.cwd(), 'docs/staging');

export function resolveEvidenceOutputPath(rawPath: string): string {
  if (!rawPath.trim()) {
    throw new Error('--evidence-out must not be empty.');
  }

  const targetPath = resolve(process.cwd(), rawPath);
  const relativePath = relative(EVIDENCE_ROOT, targetPath);
  const insideEvidenceRoot = relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));

  if (!insideEvidenceRoot) {
    throw new Error(`--evidence-out must stay under docs/staging; received ${rawPath}`);
  }

  return targetPath;
}
