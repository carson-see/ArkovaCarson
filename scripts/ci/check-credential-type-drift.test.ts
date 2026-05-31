import { describe, expect, it } from 'vitest';
import {
  collectCredentialTypeDrift,
  extractRecordValues,
  extractTypes,
} from './check-credential-type-drift.js';

const CANONICAL = ['DEGREE', 'LICENSE', 'OTHER'];

describe('check-credential-type-drift', () => {
  it('extracts canonical credential type arrays', () => {
    const source = `
      export const ANCHOR_CREDENTIAL_TYPES = [
        'DEGREE',
        'LICENSE',
        'OTHER',
      ] as const;
    `;

    expect(extractTypes(source, /ANCHOR_CREDENTIAL_TYPES\s*=\s*\[([\s\S]*?)\]\s*as\s*const/)).toEqual(CANONICAL);
  });

  it('extracts SecureDocumentDialog fuzzy map target values', () => {
    const source = `
      const typeMap: Record<string, string> = {
        'DIPLOMA': 'DEGREE',
        'LICENSE': 'LICENSE',
        'GENERAL': 'OTHER',
      };
    `;

    expect(extractRecordValues(source, 'typeMap')).toEqual(CANONICAL);
  });

  it('flags SecureDocumentDialog fuzzy map drift from canonical credential taxonomy', () => {
    const violations = collectCredentialTypeDrift({
      canonicalTypes: CANONICAL,
      locations: [
        {
          description: 'SecureDocumentDialog fuzzy type map',
          file: 'src/components/anchor/SecureDocumentDialog.tsx',
          types: ['DEGREE', 'OTHER'],
        },
      ],
    });

    expect(violations).toEqual([
      {
        description: 'SecureDocumentDialog fuzzy type map',
        file: 'src/components/anchor/SecureDocumentDialog.tsx',
        missing: ['LICENSE'],
        extra: [],
      },
    ]);
  });
});
