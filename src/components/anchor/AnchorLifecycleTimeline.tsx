/**
 * Anchor Lifecycle Timeline
 *
 * Displays the chronological progression of an anchor through its lifecycle:
 * Created → Issued → Secured → (Revoked | Expired)
 *
 * Shows timestamps for each completed step and highlights the current state.
 *
 * @see P4-TS-02 — Anchor lifecycle UI
 */

import {
  Clock,
  XCircle,
  AlertTriangle,
  FileCheck,
  Shield,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { LIFECYCLE_LABELS } from '@/lib/copy';

interface LifecycleEvent {
  label: string;
  timestamp: string | null;
  icon: React.ElementType;
  status: 'completed' | 'current' | 'upcoming' | 'terminal';
  detail?: string;
}

export interface AnchorLifecycleData {
  status: 'PENDING' | 'SECURED' | 'REVOKED' | 'EXPIRED' | 'SUBMITTED';
  createdAt: string;
  issuedAt?: string;
  securedAt?: string;
  revokedAt?: string;
  revocationReason?: string;
  expiresAt?: string;
}

function buildLifecycleEvents(data: AnchorLifecycleData): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];

  // Created — always present
  events.push({
    label: LIFECYCLE_LABELS.CREATED,
    timestamp: data.createdAt,
    icon: FileCheck,
    status: 'completed',
  });

  // Issued — only if issued_at is set
  if (data.issuedAt) {
    events.push({
      label: LIFECYCLE_LABELS.ISSUED,
      timestamp: data.issuedAt,
      icon: FileCheck,
      status: 'completed',
    });
  }

  // Secured
  if (data.status === 'PENDING' || data.status === 'SUBMITTED') {
    events.push({
      label: LIFECYCLE_LABELS.SECURED,
      timestamp: null,
      icon: Clock,
      status: 'current',
    });
  } else {
    events.push({
      label: LIFECYCLE_LABELS.SECURED,
      timestamp: data.securedAt ?? null,
      icon: Shield,
      status: data.status === 'SECURED' ? 'current' : 'completed',
    });
  }

  // Revoked — only if revoked
  if (data.status === 'REVOKED') {
    events.push({
      label: LIFECYCLE_LABELS.REVOKED,
      timestamp: data.revokedAt ?? null,
      icon: XCircle,
      status: 'terminal',
      detail: data.revocationReason ?? undefined,
    });
  }

  // Expired — only if expired
  if (data.status === 'EXPIRED') {
    events.push({
      label: LIFECYCLE_LABELS.EXPIRED,
      timestamp: data.expiresAt ?? null,
      icon: AlertTriangle,
      status: 'terminal',
    });
  }

  // Show upcoming expiry for active records
  if (data.expiresAt && data.status !== 'EXPIRED' && data.status !== 'REVOKED') {
    events.push({
      label: LIFECYCLE_LABELS.EXPIRES_ON,
      timestamp: data.expiresAt,
      icon: AlertTriangle,
      status: 'upcoming',
    });
  }

  return events;
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

const statusStyles = {
  completed: {
    dot: 'bg-green-500',
    line: 'bg-green-500',
    text: 'text-foreground',
    icon: 'text-green-600',
  },
  current: {
    dot: 'bg-primary ring-4 ring-primary/20',
    line: 'bg-border',
    text: 'text-foreground font-semibold',
    icon: 'text-primary',
  },
  upcoming: {
    dot: 'bg-muted-foreground/30',
    line: 'bg-border',
    text: 'text-muted-foreground',
    icon: 'text-muted-foreground',
  },
  terminal: {
    dot: 'bg-gray-500',
    line: 'bg-gray-300',
    text: 'text-foreground',
    icon: 'text-gray-500',
  },
};

interface AnchorLifecycleTimelineProps {
  data: AnchorLifecycleData;
  className?: string;
}

export function AnchorLifecycleTimeline({ data, className }: Readonly<AnchorLifecycleTimelineProps>) {
  const events = buildLifecycleEvents(data);

  return (
    <div className={cn('space-y-0', className)}>
      {events.map((event, index) => {
        const isLast = index === events.length - 1;
        const styles = statusStyles[event.status];
        const Icon = event.icon;

        return (
          <div key={`${event.label}-${index}`} className="relative flex gap-4">
            {/* Timeline line + dot */}
            <div className="flex flex-col items-center">
              <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', styles.dot)}>
                <Icon className={cn('h-4 w-4', event.status === 'completed' || event.status === 'terminal' ? 'text-white' : styles.icon)} />
              </div>
              {!isLast && (
                <div className={cn('w-0.5 flex-1 min-h-[2rem]', styles.line)} />
              )}
            </div>

            {/* Content */}
            <div className={cn('pb-6', isLast && 'pb-0')}>
              <p className={cn('text-sm leading-8', styles.text)}>
                {event.label}
              </p>
              {event.timestamp && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatDate(event.timestamp)}
                </p>
              )}
              {event.status === 'current' && !event.timestamp && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  In progress...
                </p>
              )}
              {event.detail && (
                <p className="text-xs text-muted-foreground mt-1">
                  {LIFECYCLE_LABELS.REVOCATION_REASON}: {event.detail}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
