/**
 * Provenance Timeline Component (COMP-02)
 *
 * Renders a vertical timeline of credential lifecycle events.
 * Integrated into the public verification page.
 */

import { useState, useEffect } from 'react';
import { Clock, CheckCircle, AlertTriangle, FileText, Pen, Stamp, Search, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PROVENANCE_LABELS } from '@/lib/copy';

interface ProvenanceEvent {
  event_type: string;
  timestamp: string;
  actor: string;
  evidence_reference: string | null;
  details: string | null;
  time_delta_seconds: number | null;
}

interface ProvenanceData {
  public_id: string;
  fingerprint: string;
  status: string;
  events: ProvenanceEvent[];
  anomalies: string[];
  generated_at: string;
}

const EVENT_ICONS: Record<string, React.ElementType> = {
  credential_created: FileText,
  anchor_submitted: Clock,
  batch_included: FileText,
  network_confirmed: CheckCircle,
  credential_revoked: AlertTriangle,
  signature_created: Pen,
  signature_completed: CheckCircle,
  timestamp_acquired: Stamp,
  verification_query: Search,
};

const EVENT_COLORS: Record<string, string> = {
  credential_created: 'text-blue-500',
  anchor_submitted: 'text-amber-500',
  batch_included: 'text-muted-foreground',
  network_confirmed: 'text-green-500',
  credential_revoked: 'text-destructive',
  signature_created: 'text-purple-500',
  signature_completed: 'text-purple-500',
  timestamp_acquired: 'text-cyan-500',
  verification_query: 'text-muted-foreground',
};

function formatDelta(seconds: number): string {
  if (seconds < 60) return `${seconds}s later`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m later`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h later`;
  return `${Math.round(seconds / 86400)}d later`;
}

interface Props {
  publicId: string;
}

export function ProvenanceTimeline({ publicId }: Props) {
  const [data, setData] = useState<ProvenanceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!publicId || !expanded) return;

    const fetchProvenance = async () => {
      setLoading(true);
      setError(null);
      try {
        const workerUrl = import.meta.env.VITE_WORKER_URL || '';
        const resp = await fetch(`${workerUrl}/api/v1/verify/${publicId}/provenance`);
        if (!resp.ok) {
          setError(PROVENANCE_LABELS.ERROR);
          return;
        }
        setData(await resp.json());
      } catch {
        setError(PROVENANCE_LABELS.ERROR);
      } finally {
        setLoading(false);
      }
    };

    fetchProvenance();
  }, [publicId, expanded]);

  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <button
          className="flex items-center justify-between w-full text-left"
          onClick={() => setExpanded(!expanded)}
        >
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="h-4 w-4" /> {PROVENANCE_LABELS.SECTION_TITLE}
          </CardTitle>
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </CardHeader>
      {expanded && (
        <CardContent>
          {loading && <p className="text-sm text-muted-foreground">{PROVENANCE_LABELS.LOADING}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {data && (
            <div className="space-y-4">
              {/* Anomalies */}
              {data.anomalies.length > 0 && (
                <div className="space-y-1">
                  {data.anomalies.map((a, i) => (
                    <div key={i} className="text-xs text-amber-500 flex items-center gap-1 bg-amber-500/10 rounded px-2 py-1">
                      <AlertTriangle className="h-3 w-3 shrink-0" /> {a}
                    </div>
                  ))}
                </div>
              )}

              {/* Timeline */}
              <div className="relative pl-6 space-y-0">
                {data.events.map((event, i) => {
                  const Icon = EVENT_ICONS[event.event_type] || Clock;
                  const color = EVENT_COLORS[event.event_type] || 'text-muted-foreground';
                  return (
                    <div key={i} className="relative pb-4 last:pb-0">
                      {/* Vertical line */}
                      {i < data.events.length - 1 && (
                        <div className="absolute left-[-16px] top-5 bottom-0 w-px bg-border" />
                      )}
                      {/* Icon dot */}
                      <div className={`absolute left-[-20px] top-1 ${color}`}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      {/* Content */}
                      <div>
                        <div className="flex items-baseline gap-2">
                          <span className="text-xs font-medium capitalize">
                            {event.event_type.replace(/_/g, ' ')}
                          </span>
                          {event.time_delta_seconds !== null && event.time_delta_seconds > 0 && (
                            <span className="text-[10px] text-muted-foreground">
                              {formatDelta(event.time_delta_seconds)}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {new Date(event.timestamp).toLocaleString()}
                        </div>
                        {event.details && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">{event.details}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Export */}
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `provenance-${publicId}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  {PROVENANCE_LABELS.EXPORT_JSON}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
