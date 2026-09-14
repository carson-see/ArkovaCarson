/**
 * driveLinks.test.ts — SCRUM-4507.
 *
 * Same security property as `docusignLinks.test.ts`, one class of identifier
 * lower: Drive ids are NOT UUIDs, so the validator is a character-class gate
 * (`[A-Za-z0-9_-]`) rather than a shape gate. That class is the whole defence:
 * a value containing `:`, `/`, `.`, `%`, whitespace or anything else cannot
 * match, so no `javascript:` URL, no traversal segment and no absolute
 * `https://evil...` origin can ever reach the template literal that builds
 * the href. Every builder returns `null` — never a best-effort URL.
 */

import { describe, it, expect } from 'vitest';
import { isDriveId, fileUrl, folderUrl, sharedDriveUrl } from './driveLinks';

const VALID_FILE_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const VALID_FOLDER_ID = '0AItPHASE_folder_id_9xYz';
const VALID_SHARED_DRIVE_ID = '0AOaBcDeFgHiJkLmNoP';

/**
 * Every one of these must produce `null`, not a URL. The injection vectors are
 * listed explicitly rather than generated so a future relaxation of the regex
 * has to delete a named vector to go green.
 */
const REJECTED: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['empty string', ''],
  ['whitespace only', '   '],
  ['a number', 123456789012],
  ['an object', { id: VALID_FILE_ID }],
  ['an array', [VALID_FILE_ID]],
  ['too short (9 chars)', '123456789'],
  ['javascript: scheme', 'javascript:alert(1)'],
  ['javascript: scheme with a valid-looking tail', `javascript:${VALID_FILE_ID}`],
  ['data: URL', 'data:text/html;base64,PHNjcmlwdD4='],
  ['absolute https origin', 'https://evil.example.com/steal'],
  ['protocol-relative origin', '//evil.example.com/steal'],
  ['parent traversal', '../../../etc/passwd'],
  ['encoded parent traversal', '%2e%2e%2f%2e%2e%2fadmin'],
  ['traversal appended to a valid id', `${VALID_FILE_ID}/../../admin`],
  ['query-string smuggling', `${VALID_FILE_ID}?redirect=https://evil.example.com`],
  ['fragment smuggling', `${VALID_FILE_ID}#https://evil.example.com`],
  ['embedded newline', `${VALID_FILE_ID}\nSet-Cookie: x=1`],
  ['embedded space', `${VALID_FILE_ID} and more`],
  ['a dot (Drive ids have none)', '1BxiMVs0XRA5.nFMdKvBdBZjgmUUqptlbs'],
  ['a colon', 'mtime:2026-05-04T01:23:00Z'],
];

describe('isDriveId', () => {
  it('accepts a real-shaped Drive file id', () => {
    expect(isDriveId(VALID_FILE_ID)).toBe(true);
  });

  it('accepts ids containing the URL-safe base64 characters Drive uses', () => {
    expect(isDriveId('abc-DEF_ghi012')).toBe(true);
  });

  it('accepts exactly 10 characters (the lower bound) and rejects 9', () => {
    expect(isDriveId('abcdefghij')).toBe(true);
    expect(isDriveId('abcdefghi')).toBe(false);
  });

  for (const [label, value] of REJECTED) {
    it(`rejects ${label}`, () => {
      expect(isDriveId(value)).toBe(false);
    });
  }
});

describe('fileUrl', () => {
  it('builds the fixed Drive file-view URL', () => {
    expect(fileUrl(VALID_FILE_ID)).toBe(
      `https://drive.google.com/file/d/${VALID_FILE_ID}/view`,
    );
  });

  for (const [label, value] of REJECTED) {
    it(`returns null for ${label}`, () => {
      expect(fileUrl(value)).toBeNull();
    });
  }
});

describe('folderUrl', () => {
  it('builds the fixed Drive folder URL', () => {
    expect(folderUrl(VALID_FOLDER_ID)).toBe(
      `https://drive.google.com/drive/folders/${VALID_FOLDER_ID}`,
    );
  });

  for (const [label, value] of REJECTED) {
    it(`returns null for ${label}`, () => {
      expect(folderUrl(value)).toBeNull();
    });
  }
});

describe('sharedDriveUrl', () => {
  it('builds the shared-drive root URL from the folders base', () => {
    expect(sharedDriveUrl(VALID_SHARED_DRIVE_ID)).toBe(
      `https://drive.google.com/drive/folders/${VALID_SHARED_DRIVE_ID}`,
    );
  });

  for (const [label, value] of REJECTED) {
    it(`returns null for ${label}`, () => {
      expect(sharedDriveUrl(value)).toBeNull();
    });
  }
});

describe('URL origin is fixed, never derived from input', () => {
  it('every built URL starts with the literal drive.google.com origin', () => {
    for (const url of [
      fileUrl(VALID_FILE_ID),
      folderUrl(VALID_FOLDER_ID),
      sharedDriveUrl(VALID_SHARED_DRIVE_ID),
    ]) {
      expect(url).not.toBeNull();
      expect(url!.startsWith('https://drive.google.com/')).toBe(true);
      expect(new URL(url!).origin).toBe('https://drive.google.com');
    }
  });

  it('takes no environment argument — there is no demo/prod Drive split to select', () => {
    // The DocuSign builders take an `env` because DocuSign has two consoles.
    // Drive has one. A second parameter here would be a knob with nothing
    // behind it, and metadata-driven base selection is exactly the shape this
    // module refuses to have.
    expect(fileUrl.length).toBe(1);
    expect(folderUrl.length).toBe(1);
    expect(sharedDriveUrl.length).toBe(1);
  });
});
