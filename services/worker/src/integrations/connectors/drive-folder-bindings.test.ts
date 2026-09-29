import { describe, expect, it } from 'vitest';
import { parseDriveFolderBindings } from './drive-folder-bindings.js';

describe('parseDriveFolderBindings', () => {
  it('type-gates the legacy field and dedupes it behind the named array entry', () => {
    expect(parseDriveFolderBindings({ folder_id: 'stray' })).toEqual([]);
    expect(parseDriveFolderBindings({
      type: 'drive_folder', folder_id: 'same', folder_path: '/legacy',
      drive_folders: [
        { folder_id: 'same', folder_name: 'Named', folder_path: '/named' },
        { folder_id: 'other', folder_name: 'Other' },
      ],
    })).toEqual([
      { folderId: 'same', folderName: 'Named', folderPath: '/named' },
      { folderId: 'other', folderName: 'Other' },
    ]);
  });
});
