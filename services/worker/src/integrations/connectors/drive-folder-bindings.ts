export interface DriveFolderBinding {
  folderId: string;
  folderName?: string;
  folderPath?: string;
}

/** Canonical folder-binding contract shared by Drive processing, rules and health. */
export function parseDriveFolderBindings(config: unknown): DriveFolderBinding[] {
  if (!config || typeof config !== 'object') return [];
  const cfg = config as Record<string, unknown>;
  const folders = new Map<string, DriveFolderBinding>();
  if (Array.isArray(cfg.drive_folders)) {
    for (const entry of cfg.drive_folders) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.folder_id !== 'string' || row.folder_id.length === 0 || folders.has(row.folder_id)) continue;
      folders.set(row.folder_id, {
        folderId: row.folder_id,
        ...(typeof row.folder_name === 'string' && row.folder_name.trim() ? { folderName: row.folder_name } : {}),
        ...(typeof row.folder_path === 'string' ? { folderPath: row.folder_path } : {}),
      });
    }
  }
  if (cfg.type === 'drive_folder' && typeof cfg.folder_id === 'string' && cfg.folder_id.length > 0 && !folders.has(cfg.folder_id)) {
    folders.set(cfg.folder_id, {
      folderId: cfg.folder_id,
      ...(typeof cfg.folder_path === 'string' ? { folderPath: cfg.folder_path } : {}),
    });
  }
  return [...folders.values()];
}

export function driveFolderIds(config: unknown): string[] {
  return parseDriveFolderBindings(config).map(({ folderId }) => folderId);
}
