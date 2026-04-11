/**
 * Export Data Button — GDPR Art. 15 + Art. 20 (REG-11 / SCRUM-572)
 *
 * Self-service "Download My Data" button. Calls the worker
 * GET /api/account/export endpoint, receives the JSON payload, and triggers
 * a browser download. Rate-limited server-side to 1 request per 24 hours.
 */

import { useState, useCallback } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { workerFetch } from '@/lib/workerClient';

export function ExportDataButton() {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    setDownloading(true);
    setError(null);

    try {
      const response = await workerFetch('/api/account/export', { method: 'GET' });

      if (response.status === 429) {
        setError('You have already exported your data in the last 24 hours. Please wait and try again later.');
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as Record<string, string>;
        throw new Error(data.error ?? 'Export failed');
      }

      // Read as blob so the browser can trigger a download. We intentionally do
      // NOT parse to JSON here — the server already set Content-Disposition and
      // we want to stream the bytes straight to the filesystem.
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `arkova-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setDownloading(false);
    }
  }, []);

  return (
    <div className="space-y-3">
      <Button
        variant="outline"
        size="sm"
        onClick={handleExport}
        disabled={downloading}
      >
        {downloading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Preparing download…
          </>
        ) : (
          <>
            <Download className="mr-2 h-4 w-4" />
            Download my data
          </>
        )}
      </Button>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
