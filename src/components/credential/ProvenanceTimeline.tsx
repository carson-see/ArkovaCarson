/**
 * Provenance Timeline Component (COMP-02)
 *
 * Renders a vertical timeline of lifecycle events for a credential.
 * Integrated into PublicVerifyPage as a collapsible section.
 */

import { useState } from 'react';
import { Clock, Upload, Fingerprint, Globe, XCircle, Search, Pen, Stamp, AlertTriangle, Download, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PROVENANCE_LABELS } from '@/lib/copy';

export interface ProvenanceEventData {
  event_type: string;
  timestamp: string;
  actor?: string;
  evidence_reference?: string;
  time_delta_seconds?: number;
  anomaly?: boolean;
}

interface ProvenanceTimelineProps {
  events: ProvenanceEventData[];
  loading: boolean;
  error?: string;
}

const EVENT_CONFIG: Record<string, { label: string; icon: typeof Clock }> = {
  credential_uploaded: { label: PROVENANCE_LABELS.EVENT_UPLOADED, icon: Upload },
  fingerprint_computed: { label: PROVENANCE_LABELS.EVENT_FINGERPRINT, icon: Fingerprint },
  network_confirmed: { label: PROVENANCE_LABELS.EVENT_NETWORK_CONFIRMED, icon: Globe },
  credential_revoked: { label: PROVENANCE_LABELS.EVENT_REVOKED, icon: XCircle },
  verification_queried: { label: PROVENANCE_LABELS.EVENT_VERIFICATION, icon: Search },
  signature_created: { label: PROVENANCE_LABELS.EVENT_SIGNATURE, icon: Pen },
  timestamp_acquired: { label: PROVENANCE_LABELS.EVENT_TIMESTAMP, icon: Stamp },
};

function formatTimeDelta(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds later`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes later`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours later`;
  return `${Math.round(seconds / 86400)} days later`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

export function ProvenanceTimeline({ events, loading, error }: ProvenanceTimelineProps) {
  const [expanded, setExpanded] = useState(false);

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'provenance-timeline.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-lg border">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">{PROVENANCE_LABELS.SECTION_TITLE}</span>
        </div>
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="border-t px-4 py-4">
          {loading && (
            <p className="text-sm text-muted-foreground">{PROVENANCE_LABELS.LOADING}</p>
          )}

          {error && !loading && (
            <p className="text-sm text-destructive">{PROVENANCE_LABELS.ERROR}</p>
          )}

          {!loading && !error && events.length === 0 && (
            <p className="text-sm text-muted-foreground">{PROVENANCE_LABELS.NO_EVENTS}</p>
          )}

          {!loading && !error && events.length > 0 && (
            <>
              <div className="relative ml-3 space-y-0">
                {events.map((event, index) => {
                  const config = EVENT_CONFIG[event.event_type] ?? { label: event.event_type, icon: Clock };
                  const Icon = config.icon;
                  const isLast = index === events.length - 1;

                  return (
                    <div key={`${event.event_type}-${event.timestamp}-${index}`} className="relative pb-4">
                      {/* Vertical line */}
                      {!isLast && (
                        <div className="absolute left-[7px] top-5 h-full w-px bg-border" />
                      )}

                      <div className="flex items-start gap-3">
                        {/* Dot */}
                        <div className={`relative z-10 mt-0.5 flex h-4 w-4 items-center justify-center rounded-full ${
                          event.anomaly ? 'bg-destructive/20' : 'bg-primary/20'
                        }`}>
                          <Icon className={`h-2.5 w-2.5 ${event.anomaly ? 'text-destructive' : 'text-primary'}`} />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium">{config.label}</span>
                            {event.anomaly && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                                <AlertTriangle className="h-3 w-3" />
                                {PROVENANCE_LABELS.ANOMALY_LABEL}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">{formatTimestamp(event.timestamp)}</p>
                          {event.time_delta_seconds !== undefined && event.time_delta_seconds > 0 && (
                            <p className="text-xs text-muted-foreground/70">{formatTimeDelta(event.time_delta_seconds)}</p>
                          )}
                          {event.evidence_reference && (
                            <p className="text-xs font-mono text-muted-foreground truncate">{event.evidence_reference}</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="mt-4 flex justify-end">
                <Button variant="outline" size="sm" onClick={handleExport}>
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  {PROVENANCE_LABELS.EXPORT_JSON}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
