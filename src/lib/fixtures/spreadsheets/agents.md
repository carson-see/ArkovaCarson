# agents.md — lib/fixtures/spreadsheets

_Last updated: 2026-07-28 (W2 / F1 spreadsheet dual-mode)_

## What This Folder Contains

Small, REAL (genuinely valid, non-mocked) spreadsheet binaries used by
`src/lib/ocrWorker.test.ts` (document-mode SheetJS extraction) and
`src/lib/xlsxParser.test.ts` (row-mode `read-excel-file` regression pin).
Every file encodes the exact same 3-row roster (`Name,Role,Notes`) so tests
can assert identical extracted content across formats.

- `sample-roster.xlsx` — Office Open XML (SheetJS `bookType: 'xlsx'`)
- `sample-roster.xls` — legacy BIFF8 (SheetJS `bookType: 'xls'`)
- `sample-roster.ods` — OpenDocument Spreadsheet (SheetJS `bookType: 'ods'`)
- `sample-roster.csv` — plain CSV (SheetJS `bookType: 'csv'`, for parity —
  the extraction path for `.csv` in `ocrWorker.ts` is the pre-existing plain
  text reader, not SheetJS, but the fixture stays consistent with the others)

## Why committed binaries, not synthesized at test time

These are tiny (4–16 KB) and deterministic. Committing them means the test
suite exercises the REAL `xlsx` (SheetJS) reader against genuine binary
bytes end-to-end, rather than only round-tripping through the same
library's own writer inside the test file — a stronger regression pin for
"does the real dependency actually parse this format".

## Regenerating

Requires the `xlsx` package (already a pinned dependency, `xlsx@0.18.5`).
Run from the repo root:

```js
node -e "
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const rows = [
  ['Name', 'Role', 'Notes'],
  ['Alice Rivera', 'Engineer', 'Backend team'],
  ['Bob Chen', 'Designer', 'Design system'],
  ['Cara Osei', 'PM', 'Roadmap owner'],
];

const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet(rows);
XLSX.utils.book_append_sheet(wb, ws, 'Roster');

const outDir = path.join('src', 'lib', 'fixtures', 'spreadsheets');
for (const [filename, bookType] of [
  ['sample-roster.xlsx', 'xlsx'],
  ['sample-roster.xls', 'xls'],
  ['sample-roster.ods', 'ods'],
  ['sample-roster.csv', 'csv'],
]) {
  fs.writeFileSync(path.join(outDir, filename), XLSX.write(wb, { bookType, type: 'buffer' }));
}
"
```

If the roster content ever changes, update the `EXPECTED_ROWS` /
per-row assertions in `ocrWorker.test.ts` and `xlsxParser.test.ts` to match.

## Do / Don't Rules

- DO: Keep every format's rows/columns identical — tests assert the same
  content across formats.
- DO NOT: Add PII or realistic personal data here — this is synthetic
  fixture data checked into git history permanently.
- DO NOT: Grow this folder into a general spreadsheet test-data dump; it
  backs exactly the two test files named above.
