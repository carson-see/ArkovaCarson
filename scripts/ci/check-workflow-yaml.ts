import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { isMainModule } from './lib/ciContext.js';

export interface WorkflowYamlError { path: string; message: string }

export function parseWorkflowYaml(path: string, source: string): WorkflowYamlError[] {
  try {
    const document = load(source, { filename: path, json: false });
    if (document === null || typeof document !== 'object' || Array.isArray(document)) {
      return [{ path, message: 'workflow root must be a mapping' }];
    }
    const workflow = document as Record<string, unknown>;
    if (typeof workflow.name !== 'string' || !('on' in workflow) || typeof workflow.jobs !== 'object' || workflow.jobs === null || Array.isArray(workflow.jobs)) {
      return [{ path, message: 'workflow must contain name, on, and a jobs mapping' }];
    }
    return [];
  } catch (error) {
    return [{ path, message: error instanceof Error ? error.message : String(error) }];
  }
}

export function checkWorkflowYaml(repoRoot = process.cwd()): WorkflowYamlError[] {
  const directory = resolve(repoRoot, '.github', 'workflows');
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .flatMap((name) => {
      const path = `.github/workflows/${name}`;
      return parseWorkflowYaml(path, readFileSync(resolve(directory, name), 'utf8'));
    });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const errors = checkWorkflowYaml();
  for (const error of errors) console.error(`${error.path}: ${error.message}`);
  if (errors.length > 0) process.exitCode = 1;
  else console.log('All GitHub Actions workflow YAML files parse successfully.');
}
