import { describe, expect, it } from 'vitest';
import type { Folder } from '@/hooks/useFolders';
import { folderDestinationLabel } from './RuleBuilderPage';

const folders: Folder[] = [
  { id: 'root', name: 'Legal', ownerScope: 'ORG', createdAt: '', connectorProvider: 'google_drive' },
  { id: 'child', name: 'Signed', ownerScope: 'ORG', createdAt: '', parentFolderId: 'root', connectorProvider: 'docusign' },
];

describe('folderDestinationLabel', () => {
  it('disambiguates a destination with its canonical nested path and connector', () => {
    expect(folderDestinationLabel(folders[1], folders)).toBe('Legal / Signed · DocuSign');
  });

  it('terminates safely when malformed folder ancestry contains a cycle', () => {
    const cyclic = [{ ...folders[0], parentFolderId: 'child' }, folders[1]];
    expect(folderDestinationLabel(cyclic[1], cyclic)).toBe('Legal / Signed · DocuSign');
  });
});
