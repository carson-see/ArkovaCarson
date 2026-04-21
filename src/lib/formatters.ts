/**
 * Shared display formatters used across pages and components.
 *
 * Keep this module free of React, routing, and Supabase imports so it
 * can be reused from server-side test helpers and CSV exporters without
 * pulling in the browser runtime.
 */

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
