import { describe, expect, it } from 'vitest';
import {
  buildRepoGraph,
  classifyOrphans,
  collectDeclaredExports,
  collectRawImports,
  isComponentFile,
  isHookFile,
  isReachable,
  isTestOrStorybookFile,
  parseAddedLines,
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

describe('parseAddedLines', () => {
  it('parses a unified=0 diff into added-line numbers per file', () => {
    const diff = [
      'diff --git a/src/hooks/useFoo.ts b/src/hooks/useFoo.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/hooks/useFoo.ts',
      '@@ -0,0 +1,3 @@',
      '+export function useFoo() {',
      '+  return 1;',
      '+}',
    ].join('\n');
    const added = parseAddedLines(diff);
    expect([...added.get('src/hooks/useFoo.ts')!].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('tracks the correct new-file line number for a hunk that starts mid-file', () => {
    const diff = [
      '--- a/src/hooks/useFoo.ts',
      '+++ b/src/hooks/useFoo.ts',
      '@@ -10,0 +11,2 @@',
      '+export function useBar() {}',
      '+export function useBaz() {}',
    ].join('\n');
    const added = parseAddedLines(diff);
    expect([...added.get('src/hooks/useFoo.ts')!].sort((a, b) => a - b)).toEqual([11, 12]);
  });

  it('ignores removed lines and deleted files', () => {
    const diff = ['--- a/src/hooks/useFoo.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-export function useFoo() {}', '-'].join(
      '\n',
    );
    expect(parseAddedLines(diff).size).toBe(0);
  });
});

describe('classifyOrphans — the diff-scoping split (CTO ruling R14)', () => {
  const exp: DiscoveredExport = { file: 'src/hooks/useOrphan.ts', name: 'useOrphan', kind: 'hook', line: 1 };

  it('marks an unreachable export as NEW when its line is in the added-lines set', () => {
    const addedLines = new Map([[exp.file, new Set([1])]]);
    const [finding] = classifyOrphans([exp], [], addedLines);
    expect(finding.isNew).toBe(true);
  });

  it('marks an unreachable export as pre-existing (warn-only) when its line is NOT in the added-lines set', () => {
    const addedLines = new Map([[exp.file, new Set([42])]]);
    const [finding] = classifyOrphans([exp], [], addedLines);
    expect(finding.isNew).toBe(false);
  });

  it('marks an unreachable export as pre-existing when the file has no diff entry at all (push/main context)', () => {
    const [finding] = classifyOrphans([exp], [], new Map());
    expect(finding.isNew).toBe(false);
  });

  it('omits a reachable export entirely — it is not an orphan, new or otherwise', () => {
    const edges = [
      { from: 'src/pages/X.tsx', to: exp.file, bindings: new Map([[exp.name, exp.name]]), kind: 'import' as const },
    ];
    const addedLines = new Map([[exp.file, new Set([1])]]);
    expect(classifyOrphans([exp], edges, addedLines)).toEqual([]);
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

  it('full pipeline: buildRepoGraph + classifyOrphans separates a new orphan from a pre-existing one', () => {
    const files = new Map<string, string>([
      ['src/hooks/useNewOrphan.ts', `export function useNewOrphan() { return 1; }\n`],
      ['src/hooks/useOldOrphan.ts', `export function useOldOrphan() { return 1; }\n`],
    ]);
    const { exports, edges } = buildRepoGraph(files);
    const addedLines = new Map([['src/hooks/useNewOrphan.ts', new Set([1])]]);
    const orphans = classifyOrphans(exports, edges, addedLines);

    const byName = Object.fromEntries(orphans.map((o) => [o.name, o.isNew]));
    expect(byName).toEqual({ useNewOrphan: true, useOldOrphan: false });
  });
});
