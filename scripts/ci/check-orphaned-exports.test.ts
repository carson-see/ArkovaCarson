import { describe, expect, it } from 'vitest';
import {
  buildMergeBaseExportIndex,
  buildRepoGraph,
  classifyOrphans,
  collectDeclaredExports,
  collectRawImports,
  exportIdentityKey,
  findOrphanCandidates,
  isComponentFile,
  isHookFile,
  isReachable,
  isTestOrStorybookFile,
  parseRenameMap,
  specifierResolvedPath,
  type DiscoveredExport,
} from './check-orphaned-exports.ts';
import ts from 'typescript';

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.ES2022,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

describe('path predicates', () => {
  it('isTestOrStorybookFile matches test/spec/stories, not plain files', () => {
    expect(isTestOrStorybookFile('src/hooks/useFoo.test.ts')).toBe(true);
    expect(isTestOrStorybookFile('src/hooks/useFoo.spec.tsx')).toBe(true);
    expect(isTestOrStorybookFile('src/components/Foo.stories.tsx')).toBe(true);
    expect(isTestOrStorybookFile('src/hooks/useFoo.ts')).toBe(false);
  });

  it('isHookFile / isComponentFile scope to their directories and exclude test files', () => {
    expect(isHookFile('src/hooks/useFoo.ts')).toBe(true);
    expect(isHookFile('src/hooks/useFoo.test.ts')).toBe(false);
    expect(isHookFile('src/components/Foo.tsx')).toBe(false);
    expect(isComponentFile('src/components/Foo.tsx')).toBe(true);
    expect(isComponentFile('src/components/ui/index.ts')).toBe(true);
    expect(isComponentFile('src/components/Foo.stories.tsx')).toBe(false);
  });
});

describe('collectDeclaredExports', () => {
  it('picks up an exported hook function matching use[A-Z] under src/hooks', () => {
    const src = parse('src/hooks/useFoo.ts', `export function useFoo() { return 1; }\n`);
    const exports = collectDeclaredExports(src, 'src/hooks/useFoo.ts', 'hook');
    expect(exports).toEqual([{ file: 'src/hooks/useFoo.ts', name: 'useFoo', kind: 'hook', line: 1 }]);
  });

  it('ignores a non-"use"-prefixed export in a hooks file', () => {
    const src = parse('src/hooks/useFoo.ts', `export function helperThing() { return 1; }\n`);
    expect(collectDeclaredExports(src, 'src/hooks/useFoo.ts', 'hook')).toEqual([]);
  });

  it('picks up an exported const arrow-function component', () => {
    const src = parse('src/components/Foo.tsx', `export const Foo = () => <div />;\n`);
    const exports = collectDeclaredExports(src, 'src/components/Foo.tsx', 'component');
    expect(exports).toEqual([{ file: 'src/components/Foo.tsx', name: 'Foo', kind: 'component', line: 1 }]);
  });

  it('picks up a forwardRef/memo-wrapped component (CallExpression initializer)', () => {
    const src = parse(
      'src/components/Foo.tsx',
      `export const Foo = React.forwardRef((props, ref) => <div ref={ref} />);\n`,
    );
    expect(collectDeclaredExports(src, 'src/components/Foo.tsx', 'component')).toHaveLength(1);
  });

  it('does NOT classify a plain object/array literal export as a component (avoids false positives)', () => {
    const src = parse('src/components/Foo.tsx', `export const ICONS = { home: 1, user: 2 };\n`);
    expect(collectDeclaredExports(src, 'src/components/Foo.tsx', 'component')).toEqual([]);
  });

  it('does NOT classify a SCREAMING_SNAKE_CASE data constant as a component even with a CallExpression initializer', () => {
    // Real regression: src/components/webhooks/WebhookEventCatalog.tsx exports
    // `WEBHOOK_EVENT_CATALOG = AVAILABLE_EVENTS.map(...)` — a derived data
    // array, not a component, but `.map()` is a CallExpression initializer.
    const src = parse(
      'src/components/Foo.tsx',
      `export const WEBHOOK_EVENT_CATALOG = AVAILABLE_EVENTS.map((e) => e.id);\n`,
    );
    expect(collectDeclaredExports(src, 'src/components/Foo.tsx', 'component')).toEqual([]);
  });

  it('picks up an exported class component', () => {
    const src = parse('src/components/Foo.tsx', `export class Foo extends React.Component {}\n`);
    expect(collectDeclaredExports(src, 'src/components/Foo.tsx', 'component')).toHaveLength(1);
  });

  it('returns [] when kindForFile is null', () => {
    const src = parse('src/lib/util.ts', `export function useNotAHook() { return 1; }\n`);
    expect(collectDeclaredExports(src, 'src/lib/util.ts', null)).toEqual([]);
  });
});

describe('collectRawImports', () => {
  it('captures a named import with alias, keyed by the SOURCE name', () => {
    const src = parse('src/pages/X.tsx', `import { useFoo as useBar } from '@/hooks/useFoo';\n`);
    const [raw] = collectRawImports(src);
    expect(raw.kind).toBe('import');
    expect(raw.bindings).not.toBe('ALL');
    expect((raw.bindings as Map<string, string>).get('useFoo')).toBe('useBar');
  });

  it('captures a default import as the "default" binding', () => {
    const src = parse('src/pages/X.tsx', `import Foo from '@/components/Foo';\n`);
    const [raw] = collectRawImports(src);
    expect((raw.bindings as Map<string, string>).get('default')).toBe('Foo');
  });

  it('captures a namespace import as ALL', () => {
    const src = parse('src/pages/X.tsx', `import * as hooks from '@/hooks';\n`);
    const [raw] = collectRawImports(src);
    expect(raw.bindings).toBe('ALL');
  });

  it('ignores a side-effect-only import (no binding to track)', () => {
    const src = parse('src/pages/X.tsx', `import '@/lib/polyfill';\n`);
    expect(collectRawImports(src)).toEqual([]);
  });

  it('captures `export { X } from` as a reexport edge keyed by source name -> exposed alias', () => {
    const src = parse('src/hooks/index.ts', `export { useFoo as useBar } from './useFoo';\n`);
    const [raw] = collectRawImports(src);
    expect(raw.kind).toBe('reexport');
    expect((raw.bindings as Map<string, string>).get('useFoo')).toBe('useBar');
  });

  it('captures `export * from` as a reexport ALL edge', () => {
    const src = parse('src/hooks/index.ts', `export * from './useFoo';\n`);
    const [raw] = collectRawImports(src);
    expect(raw.kind).toBe('reexport');
    expect(raw.bindings).toBe('ALL');
  });

  it('captures a dynamic import() nested inside React.lazy(() => ...).then(...) as an ALL import edge', () => {
    const src = parse(
      'src/App.tsx',
      `const X = lazyWithRetry(() => import('@/pages/X').then(m => ({ default: m.X })));\n`,
    );
    const dynamicImports = collectRawImports(src).filter((r) => r.specifier === '@/pages/X');
    expect(dynamicImports).toHaveLength(1);
    expect(dynamicImports[0].kind).toBe('import');
    expect(dynamicImports[0].bindings).toBe('ALL');
  });
});

describe('specifierResolvedPath', () => {
  const fileSet = new Set([
    'src/hooks/useFoo.ts',
    'src/hooks/index.ts',
    'src/components/ui/Button.tsx',
    'src/components/ui/index.ts',
  ]);

  it('resolves a relative specifier with no extension', () => {
    expect(specifierResolvedPath('src/hooks/index.ts', './useFoo', fileSet)).toBe('src/hooks/useFoo.ts');
  });

  it('resolves the "@/" alias to src/', () => {
    expect(specifierResolvedPath('src/pages/X.tsx', '@/hooks/useFoo', fileSet)).toBe('src/hooks/useFoo.ts');
  });

  it('resolves a directory specifier to its index file', () => {
    expect(specifierResolvedPath('src/pages/X.tsx', '@/components/ui', fileSet)).toBe(
      'src/components/ui/index.ts',
    );
  });

  it('returns null for a bare/node_modules specifier', () => {
    expect(specifierResolvedPath('src/pages/X.tsx', 'react', fileSet)).toBeNull();
  });

  it('returns null when the resolved file is not in the scanned set', () => {
    expect(specifierResolvedPath('src/pages/X.tsx', '@/hooks/useMissing', fileSet)).toBeNull();
  });
});

describe('isReachable', () => {
  const target: DiscoveredExport = { file: 'src/hooks/useFoo.ts', name: 'useFoo', kind: 'hook', line: 1 };

  it('is false with no edges at all', () => {
    expect(isReachable([], target.file, target.name)).toBe(false);
  });

  it('is true for a direct real import', () => {
    const edges = [
      { from: 'src/pages/X.tsx', to: target.file, bindings: new Map([['useFoo', 'useFoo']]), kind: 'import' as const },
    ];
    expect(isReachable(edges, target.file, target.name)).toBe(true);
  });

  it('is false when the only importer is a test file', () => {
    const edges = [
      {
        from: 'src/hooks/useFoo.test.ts',
        to: target.file,
        bindings: new Map([['useFoo', 'useFoo']]),
        kind: 'import' as const,
      },
    ];
    expect(isReachable(edges, target.file, target.name)).toBe(false);
  });

  it('is false when the only importer is a Storybook file', () => {
    const edges = [
      {
        from: 'src/components/Foo.stories.tsx',
        to: target.file,
        bindings: new Map([['useFoo', 'useFoo']]),
        kind: 'import' as const,
      },
    ];
    expect(isReachable(edges, target.file, target.name)).toBe(false);
  });

  it('traces a real usage through a barrel re-export chain', () => {
    const edges = [
      // barrel re-exports useFoo from the defining file
      { from: 'src/hooks/index.ts', to: target.file, bindings: new Map([['useFoo', 'useFoo']]), kind: 'reexport' as const },
      // a real page imports the barrel
      { from: 'src/pages/X.tsx', to: 'src/hooks/index.ts', bindings: new Map([['useFoo', 'useFoo']]), kind: 'import' as const },
    ];
    expect(isReachable(edges, target.file, target.name)).toBe(true);
  });

  it('is false when the barrel re-exports it but the barrel itself has no real importer', () => {
    const edges = [
      { from: 'src/hooks/index.ts', to: target.file, bindings: new Map([['useFoo', 'useFoo']]), kind: 'reexport' as const },
      // only a test imports the barrel
      {
        from: 'src/hooks/index.test.ts',
        to: 'src/hooks/index.ts',
        bindings: new Map([['useFoo', 'useFoo']]),
        kind: 'import' as const,
      },
    ];
    expect(isReachable(edges, target.file, target.name)).toBe(false);
  });

  it('does not infinite-loop on a re-export cycle', () => {
    const edges = [
      { from: 'src/hooks/a.ts', to: 'src/hooks/b.ts', bindings: 'ALL' as const, kind: 'reexport' as const },
      { from: 'src/hooks/b.ts', to: 'src/hooks/a.ts', bindings: 'ALL' as const, kind: 'reexport' as const },
    ];
    expect(isReachable(edges, 'src/hooks/a.ts', 'useFoo')).toBe(false);
  });
});

describe('exportIdentityKey', () => {
  it('combines kind and name so a same-named hook and component never collide', () => {
    expect(exportIdentityKey('Foo', 'hook')).not.toBe(exportIdentityKey('Foo', 'component'));
  });
});

describe('findOrphanCandidates', () => {
  it('filters exports down to the unreachable ones only', () => {
    const reachable: DiscoveredExport = { file: 'src/hooks/useUsed.ts', name: 'useUsed', kind: 'hook', line: 1 };
    const orphan: DiscoveredExport = { file: 'src/hooks/useOrphan.ts', name: 'useOrphan', kind: 'hook', line: 1 };
    const edges = [
      {
        from: 'src/pages/X.tsx',
        to: reachable.file,
        bindings: new Map([[reachable.name, reachable.name]]),
        kind: 'import' as const,
      },
    ];
    const candidates = findOrphanCandidates([reachable, orphan], edges);
    expect(candidates).toEqual([orphan]);
  });
});

describe('parseRenameMap', () => {
  it('parses an R<score> rename line into new-path -> old-path', () => {
    const nameStatus = 'R100\tsrc/hooks/useOld.ts\tsrc/hooks/useNew.ts';
    const map = parseRenameMap(nameStatus);
    expect(map.get('src/hooks/useNew.ts')).toBe('src/hooks/useOld.ts');
  });

  it('ignores non-rename lines (A/M/D status)', () => {
    const nameStatus = ['M\tsrc/hooks/useFoo.ts', 'A\tsrc/hooks/useBar.ts', 'D\tsrc/hooks/useBaz.ts'].join('\n');
    expect(parseRenameMap(nameStatus).size).toBe(0);
  });

  it('handles multiple rename lines', () => {
    const nameStatus = [
      'R095\tsrc/hooks/useA.ts\tsrc/hooks/useA2.ts',
      'R100\tsrc/components/Foo.tsx\tsrc/components/Bar.tsx',
    ].join('\n');
    const map = parseRenameMap(nameStatus);
    expect(map.get('src/hooks/useA2.ts')).toBe('src/hooks/useA.ts');
    expect(map.get('src/components/Bar.tsx')).toBe('src/components/Foo.tsx');
  });
});

describe('buildMergeBaseExportIndex', () => {
  it('indexes declared hook/component exports by identity key, per file', () => {
    const files = new Map<string, string>([
      ['src/hooks/useFoo.ts', `export function useFoo() { return 1; }\n`],
      ['src/components/Foo.tsx', `export const Foo = () => <div />;\n`],
      ['src/lib/util.ts', `export function useNotScanned() { return 1; }\n`], // outside hooks/components — ignored
    ]);
    const index = buildMergeBaseExportIndex(files);
    expect(index.get('src/hooks/useFoo.ts')).toEqual(new Set([exportIdentityKey('useFoo', 'hook')]));
    expect(index.get('src/components/Foo.tsx')).toEqual(new Set([exportIdentityKey('Foo', 'component')]));
    expect(index.has('src/lib/util.ts')).toBe(false);
  });
});

describe('classifyOrphans — identity-based new-vs-pre-existing split (CTO ruling R14)', () => {
  // Regression (1): a cosmetic reformat of an existing orphan's declaration
  // line must NOT flip it to a new orphan. Reproduces the adversarial-review
  // finding against the original line-position implementation: the export's
  // line moved (2 -> 3 below, simulating a leading blank-line insertion) but
  // the identity (name + kind) is unchanged and already present at the
  // merge base for this exact file path.
  it('regression: a cosmetic reformat that shifts the declaration line stays pre-existing (exit-0 case)', () => {
    const candidate: DiscoveredExport = {
      file: 'src/hooks/useDebounce.ts',
      name: 'useDebounce',
      kind: 'hook',
      line: 3, // shifted from line 2 at the merge base by a purely cosmetic edit
    };
    const mergeBaseExports = new Map([
      ['src/hooks/useDebounce.ts', new Set([exportIdentityKey('useDebounce', 'hook')])],
    ]);
    const [finding] = classifyOrphans([candidate], mergeBaseExports);
    expect(finding.isNew).toBe(false);
  });

  // Regression (2): a genuinely new orphaned export (name never existed at
  // the merge base under this file's identity) must still fail closed.
  it('regression: a genuinely new orphaned export still fails closed (exit-1 case)', () => {
    const candidate: DiscoveredExport = {
      file: 'src/hooks/useBrandNew.ts',
      name: 'useBrandNew',
      kind: 'hook',
      line: 1,
    };
    // Merge base has no entry at all for this file (it did not exist).
    const [finding] = classifyOrphans([candidate], new Map());
    expect(finding.isNew).toBe(true);
  });

  // Control: an unrelated file with no merge-base history change at all
  // (mirrors "touching an unrelated comment line stays exit 0" from the
  // adversarial review) — same shape as the reformat case, asserting the
  // identity match is what drives the result, not incidental line stability.
  it('control: an untouched pre-existing orphan (line unchanged) stays pre-existing', () => {
    const candidate: DiscoveredExport = {
      file: 'src/hooks/useDebounce.ts',
      name: 'useDebounce',
      kind: 'hook',
      line: 2,
    };
    const mergeBaseExports = new Map([
      ['src/hooks/useDebounce.ts', new Set([exportIdentityKey('useDebounce', 'hook')])],
    ]);
    const [finding] = classifyOrphans([candidate], mergeBaseExports);
    expect(finding.isNew).toBe(false);
  });

  // Regression (3): a file rename/move of an existing orphaned file stays
  // pre-existing — resolved through the rename map to its merge-base
  // identity path, not misclassified as new by the "100% added content"
  // artifact of a plain `git diff` with no rename detection.
  it('regression: a renamed/moved file resolves through the rename map and stays pre-existing', () => {
    const candidate: DiscoveredExport = {
      file: 'src/hooks/useMoved2.ts', // new path after the move
      name: 'useMoved',
      kind: 'hook',
      line: 1,
    };
    const mergeBaseExports = new Map([
      ['src/hooks/useMoved.ts', new Set([exportIdentityKey('useMoved', 'hook')])], // old path, merge-base identity
    ]);
    const renameMap = new Map([['src/hooks/useMoved2.ts', 'src/hooks/useMoved.ts']]);
    const [finding] = classifyOrphans([candidate], mergeBaseExports, renameMap);
    expect(finding.isNew).toBe(false);
  });

  it('a genuinely new export in a file that DID exist at the merge base (but without this export) still fails closed', () => {
    const candidate: DiscoveredExport = {
      file: 'src/hooks/useMixed.ts',
      name: 'useNewOne',
      kind: 'hook',
      line: 5,
    };
    const mergeBaseExports = new Map([
      ['src/hooks/useMixed.ts', new Set([exportIdentityKey('useExistingOne', 'hook')])],
    ]);
    const [finding] = classifyOrphans([candidate], mergeBaseExports);
    expect(finding.isNew).toBe(true);
  });
});

describe('buildRepoGraph — end-to-end fixture scenarios', () => {
  it('scenario: a genuinely orphaned hook has no importer at all', () => {
    const files = new Map<string, string>([
      ['src/hooks/useOrphanExample.ts', `export function useOrphanExample() { return 1; }\n`],
    ]);
    const { exports, edges } = buildRepoGraph(files);
    expect(exports).toEqual([
      { file: 'src/hooks/useOrphanExample.ts', name: 'useOrphanExample', kind: 'hook', line: 1 },
    ]);
    expect(isReachable(edges, 'src/hooks/useOrphanExample.ts', 'useOrphanExample')).toBe(false);
  });

  it('scenario: a hook reachable only through a barrel that IS imported by real code is NOT orphaned', () => {
    const files = new Map<string, string>([
      ['src/hooks/useBarrelExample.ts', `export function useBarrelExample() { return 1; }\n`],
      ['src/hooks/index.ts', `export { useBarrelExample } from './useBarrelExample';\n`],
      [
        'src/pages/SomePage.tsx',
        `import { useBarrelExample } from '@/hooks';\nexport function SomePage() { useBarrelExample(); return null; }\n`,
      ],
    ]);
    const { exports, edges } = buildRepoGraph(files);
    expect(isReachable(edges, 'src/hooks/useBarrelExample.ts', 'useBarrelExample')).toBe(true);
    // sanity: the hook itself is still the only DISCOVERED candidate export
    // (the barrel's re-export statement is not itself a declared export)
    expect(exports.map((e) => e.name)).toEqual(['useBarrelExample']);
  });

  it('scenario: a hook exported via a barrel that NO real code imports IS orphaned', () => {
    const files = new Map<string, string>([
      ['src/hooks/useUnusedBarrelExample.ts', `export function useUnusedBarrelExample() { return 1; }\n`],
      ['src/hooks/index.ts', `export { useUnusedBarrelExample } from './useUnusedBarrelExample';\n`],
      [
        'src/hooks/index.test.ts',
        `import { useUnusedBarrelExample } from './index';\ndescribe('x', () => { it('y', () => { useUnusedBarrelExample(); }); });\n`,
      ],
    ]);
    const { edges } = buildRepoGraph(files);
    expect(isReachable(edges, 'src/hooks/useUnusedBarrelExample.ts', 'useUnusedBarrelExample')).toBe(false);
  });

  it('scenario: a component reached only via React.lazy(() => import(...)) in a router file is NOT orphaned', () => {
    const files = new Map<string, string>([
      [
        'src/components/public/LazyExampleComponent.tsx',
        `export function LazyExampleComponent() { return null; }\n`,
      ],
      [
        'src/App.tsx',
        `const LazyExampleComponent = lazyWithRetry(() => import('@/components/public/LazyExampleComponent').then(m => ({ default: m.LazyExampleComponent })));\n`,
      ],
    ]);
    const { edges } = buildRepoGraph(files);
    expect(
      isReachable(edges, 'src/components/public/LazyExampleComponent.tsx', 'LazyExampleComponent'),
    ).toBe(true);
  });

  it('scenario: a page component registered only through a router file (routes.ts + router) is NOT orphaned', () => {
    const files = new Map<string, string>([
      [
        'src/components/pages/RegisteredPage.tsx',
        `export function RegisteredPage() { return null; }\n`,
      ],
      // src/lib/routes.ts holds only path CONSTANTS in this codebase — it does
      // not itself import components. The router file is what wires the route
      // to the component via a dynamic import; routes.ts is included in the
      // scan for completeness but contributes no edges here.
      ['src/lib/routes.ts', `export const ROUTES = { REGISTERED: '/registered' } as const;\n`],
      [
        'src/AppRouter.tsx',
        `import { ROUTES } from '@/lib/routes';\nconst RegisteredPage = lazyWithRetry(() => import('@/components/pages/RegisteredPage').then(m => ({ default: m.RegisteredPage })));\n`,
      ],
    ]);
    const { edges } = buildRepoGraph(files);
    expect(isReachable(edges, 'src/components/pages/RegisteredPage.tsx', 'RegisteredPage')).toBe(true);
  });

  it('scenario: a component imported ONLY by its own .stories.tsx file is orphaned', () => {
    const files = new Map<string, string>([
      ['src/components/StorybookOnly.tsx', `export function StorybookOnly() { return null; }\n`],
      [
        'src/components/StorybookOnly.stories.tsx',
        `import { StorybookOnly } from './StorybookOnly';\nexport default { component: StorybookOnly };\n`,
      ],
    ]);
    const { edges } = buildRepoGraph(files);
    expect(isReachable(edges, 'src/components/StorybookOnly.tsx', 'StorybookOnly')).toBe(false);
  });

  it('full pipeline: buildRepoGraph + findOrphanCandidates + classifyOrphans separates a new orphan from a pre-existing one', () => {
    const files = new Map<string, string>([
      ['src/hooks/useNewOrphan.ts', `export function useNewOrphan() { return 1; }\n`],
      ['src/hooks/useOldOrphan.ts', `export function useOldOrphan() { return 1; }\n`],
    ]);
    const { exports, edges } = buildRepoGraph(files);
    const candidates = findOrphanCandidates(exports, edges);
    // Merge base only knew about useOldOrphan — useNewOrphan is genuinely new.
    const mergeBaseExports = new Map([
      ['src/hooks/useOldOrphan.ts', new Set([exportIdentityKey('useOldOrphan', 'hook')])],
    ]);
    const orphans = classifyOrphans(candidates, mergeBaseExports);

    const byName = Object.fromEntries(orphans.map((o) => [o.name, o.isNew]));
    expect(byName).toEqual({ useNewOrphan: true, useOldOrphan: false });
  });

  it('full pipeline: a cosmetic reformat of an existing orphan (line shift, same file+identity, no diff-added-lines mechanism involved) stays pre-existing', () => {
    // Regression fixture for the adversarial-review finding: simulates the
    // real repro (useDebounce.ts's declaration line shifted by a whitespace-
    // only edit) end-to-end through buildRepoGraph -> findOrphanCandidates ->
    // classifyOrphans, with the merge-base version of the SAME file (as it
    // looked before the cosmetic edit) supplying the identity match.
    const currentFiles = new Map<string, string>([
      [
        'src/hooks/useDebounce.ts',
        `\nexport function useDebounce(delay: number=300) { return delay; }\n`, // line 2, cosmetic reformat
      ],
    ]);
    const mergeBaseFiles = new Map<string, string>([
      ['src/hooks/useDebounce.ts', `export function useDebounce(delay: number = 300) { return delay; }\n`], // line 1, pre-reformat
    ]);
    const { exports, edges } = buildRepoGraph(currentFiles);
    const candidates = findOrphanCandidates(exports, edges);
    const mergeBaseExports = buildMergeBaseExportIndex(mergeBaseFiles);
    const orphans = classifyOrphans(candidates, mergeBaseExports);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].line).not.toBe(1); // the line genuinely moved...
    expect(orphans[0].isNew).toBe(false); // ...but identity resolution keeps it pre-existing
  });
});
