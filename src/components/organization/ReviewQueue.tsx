/**
 * ReviewQueue Component (P8-S9)
 *
 * Admin review queue for flagged credentials.
 * Shows pending items with integrity scores, allows approve/investigate/escalate/dismiss.
 *
 * EU AI Act compliance: Human-in-the-loop for automated AI decisions.
 * Design: "Nordic Vault" aesthetic.
 */

import { useEffect, useState } from 'react';
import {
  ShieldAlert,
  CheckCircle2,
  Search,
  AlertTriangle,
  ArrowUpCircle,
  XCircle,
  Filter,
  RefreshCw,
} from 'lucide-react';
import { useReviewQueue } from '@/hooks/useReviewQueue';
import type { ReviewAction, ReviewStatus } from '@/hooks/useReviewQueue';
import { IntegrityScoreBadge } from '@/components/anchor/IntegrityScoreBadge';
import { toast } from 'sonner';

const STATUS_FILTERS: { value: ReviewStatus | 'ALL'; label: string }[] = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'INVESTIGATING', label: 'Investigating' },
  { value: 'ESCALATED', label: 'Escalated' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'DISMISSED', label: 'Dismissed' },
];

const ACTION_CONFIG: Record<ReviewAction, {
  icon: typeof CheckCircle2;
  label: string;
  color: string;
  confirm: string;
}> = {
  APPROVE: {
    icon: CheckCircle2,
    label: 'Approve',
    color: 'text-green-600 hover:bg-green-50',
    confirm: 'Approve this credential?',
  },
  INVESTIGATE: {
    icon: Search,
    label: 'Investigate',
    color: 'text-amber-600 hover:bg-amber-50',
    confirm: 'Mark for investigation?',
  },
  ESCALATE: {
    icon: ArrowUpCircle,
    label: 'Escalate',
    color: 'text-red-600 hover:bg-red-50',
    confirm: 'Escalate this item?',
  },
  DISMISS: {
    icon: XCircle,
    label: 'Dismiss',
    color: 'text-muted-foreground hover:bg-muted/50',
    confirm: 'Dismiss this flag?',
  },
};

function getStatusBadge(status: ReviewStatus) {
  const config: Record<ReviewStatus, { bg: string; text: string }> = {
    PENDING: { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700' },
    INVESTIGATING: { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700' },
    ESCALATED: { bg: 'bg-red-50 border-red-200', text: 'text-red-700' },
    APPROVED: { bg: 'bg-green-50 border-green-200', text: 'text-green-700' },
    DISMISSED: { bg: 'bg-muted border-border', text: 'text-muted-foreground' },
  };
  const c = config[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${c.bg} ${c.text}`}>
      {status}
    </span>
  );
}

export function ReviewQueue() {
  const { items, stats, loading, acting, fetchItems, fetchStats, applyAction } = useReviewQueue();
  const [activeFilter, setActiveFilter] = useState<ReviewStatus | 'ALL'>('PENDING');
  const [actionNotes, setActionNotes] = useState('');
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  useEffect(() => {
    fetchItems(activeFilter === 'ALL' ? undefined : activeFilter);
    fetchStats();
  }, [activeFilter, fetchItems, fetchStats]);

  const handleAction = async (itemId: string, action: ReviewAction) => {
    try {
      await applyAction(itemId, action, actionNotes || undefined);
      setActionNotes('');
      setExpandedItem(null);
      toast.success(`Item ${action.toLowerCase()}d successfully`);
      fetchStats();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    }
  };

  return (
    <div className="space-y-6 animate-in-view">
      {/* Header with stats */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5">
            <ShieldAlert className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">Review Queue</h2>
            <p className="text-xs text-muted-foreground">
              {stats ? `${stats.pending} pending, ${stats.investigating} investigating` : 'Loading...'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            fetchItems(activeFilter === 'ALL' ? undefined : activeFilter);
            fetchStats();
          }}
          className="p-2 text-muted-foreground hover:text-foreground rounded-md transition-colors"
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Stats bar */}
      {stats && stats.total > 0 && (
        <div className="grid grid-cols-5 gap-2">
          {([
            { label: 'Pending', value: stats.pending, color: 'text-amber-600' },
            { label: 'Investigating', value: stats.investigating, color: 'text-blue-600' },
            { label: 'Escalated', value: stats.escalated, color: 'text-red-600' },
            { label: 'Approved', value: stats.approved, color: 'text-green-600' },
            { label: 'Dismissed', value: stats.dismissed, color: 'text-muted-foreground' },
          ]).map((stat) => (
            <div key={stat.label} className="glass-card rounded-lg p-3 text-center">
              <div className={`text-lg font-semibold ${stat.color}`}>{stat.value}</div>
              <div className="text-xs text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex items-center gap-1 border-b">
        <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() => setActiveFilter(filter.value)}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              activeFilter === filter.value
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {/* Items list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="shimmer h-20 rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="glass-card rounded-xl p-8 text-center">
          <ShieldAlert className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No items in the review queue</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div
              key={item.id}
              className={`glass-card rounded-lg border transition-all stagger-${Math.min(index + 1, 8)} ${
                expandedItem === item.id ? 'ring-2 ring-primary/20' : ''
              }`}
            >
              {/* Item header */}
              <div
                className="flex items-center justify-between p-4 cursor-pointer"
                onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {item.integrityScore != null && item.integrityLevel && (
                    <IntegrityScoreBadge
                      score={item.integrityScore}
                      level={item.integrityLevel as 'HIGH' | 'MEDIUM' | 'LOW' | 'FLAGGED'}
                      compact
                    />
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">
                      {item.anchorTitle ?? 'Untitled Record'}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {item.reason}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  {item.anchorCredentialType && (
                    <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded">
                      {item.anchorCredentialType}
                    </span>
                  )}
                  {getStatusBadge(item.status)}
                </div>
              </div>

              {/* Expanded section */}
              {expandedItem === item.id && (
                <div className="border-t px-4 py-3 space-y-3">
                  {/* Flags */}
                  {item.flags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {item.flags.map((flag) => (
                        <span
                          key={flag}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-md"
                        >
                          <AlertTriangle className="h-3 w-3" />
                          {flag.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Fingerprint */}
                  {item.anchorFingerprint && (
                    <div className="font-mono text-xs bg-muted rounded px-2 py-1 truncate">
                      {item.anchorFingerprint}
                    </div>
                  )}

                  {/* Notes input */}
                  {item.status === 'PENDING' || item.status === 'INVESTIGATING' ? (
                    <div className="space-y-2">
                      <textarea
                        placeholder="Add review notes (optional)..."
                        value={expandedItem === item.id ? actionNotes : ''}
                        onChange={(e) => setActionNotes(e.target.value)}
                        className="w-full text-sm border rounded-md px-3 py-2 bg-background resize-none"
                        rows={2}
                      />
                      <div className="flex items-center gap-2">
                        {(Object.entries(ACTION_CONFIG) as [ReviewAction, typeof ACTION_CONFIG.APPROVE][]).map(
                          ([action, config]) => {
                            const Icon = config.icon;
                            return (
                              <button
                                key={action}
                                type="button"
                                onClick={() => handleAction(item.id, action)}
                                disabled={acting}
                                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${config.color} disabled:opacity-50`}
                              >
                                <Icon className="h-3.5 w-3.5" />
                                {config.label}
                              </button>
                            );
                          },
                        )}
                      </div>
                    </div>
                  ) : (
                    item.reviewNotes && (
                      <div className="text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
                        <span className="font-medium">Notes:</span> {item.reviewNotes}
                      </div>
                    )
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
