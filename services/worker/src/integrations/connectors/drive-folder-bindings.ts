/** Pure folder-binding contract shared by Drive processing and health. */
export function driveFolderIds(config: unknown): string[] {
  if (!config || typeof config !== 'object') return [];
  const cfg = config as Record<string, unknown>;
  const folders = new Set<string>();
  if (typeof cfg.folder_id === 'string' && cfg.folder_id.length > 0) folders.add(cfg.folder_id);
  if (Array.isArray(cfg.drive_folders)) {
    for (const entry of cfg.drive_folders) {
      if (entry && typeof entry.folder_id === 'string' && entry.folder_id.length > 0) folders.add(entry.folder_id);
    }
  }
  return [...folders];
}
