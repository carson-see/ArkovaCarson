/**
 * Version Chain Section
 *
 * Displays document lineage — all versions of a credential in chronological order.
 * Shows which version is current, expired, or revoked.
 * Clicking a version navigates to its detail page.
 */

import { Link } from 'react-router-dom';
import {
  GitBranch,
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { recordDetailPath } from '@/lib/routes';
import type { ChainLink } from '@/hooks/useVersionChain';

interface VersionChainSectionProps {
  chain: ChainLink[];
}

function getStatusBadge(link: ChainLink) {
  if (link.revokedAt) {
    return <Badge variant="destructive" className="text-[10px]">Revoked</Badge>;
  }
  if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
    return <Badge variant="secondary" className="text-[10px] bg-amber-500/10 text-amber-600">Expired</Badge>;
  }
  if (link.status === 'SECURED') {
    return <Badge variant="secondary" className="text-[10px] bg-green-500/10 text-green-600">Verified</Badge>;
  }
  if (link.status === 'PENDING' || link.status === 'SUBMITTED') {
    return <Badge variant="secondary" className="text-[10px]">Processing</Badge>;
  }
  return <Badge variant="outline" className="text-[10px]">{link.status}</Badge>;
}

function getStatusIcon(link: ChainLink) {
  if (link.revokedAt) return <XCircle className="h-4 w-4 text-destructive shrink-0" />;
  if (link.expiresAt && new Date(link.expiresAt) < new Date()) return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />;
  if (link.status === 'SECURED') return <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />;
  return <Clock className="h-4 w-4 text-muted-foreground shrink-0" />;
}

export function VersionChainSection({ chain }: Readonly<VersionChainSectionProps>) {
  if (chain.length <= 1) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <GitBranch className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Version History</h3>
        <Badge variant="outline" className="text-[10px]">{chain.length} versions</Badge>
      </div>

      <div className="relative space-y-0">
        {chain.map((link, i) => (
          <div key={link.id} className="relative flex items-start gap-3 group">
            {/* Vertical connector line */}
            {i < chain.length - 1 && (
              <div className="absolute left-[7px] top-6 bottom-0 w-px bg-border" />
            )}

            {/* Timeline dot */}
            <div className={`relative z-10 mt-1.5 h-[15px] w-[15px] rounded-full border-2 shrink-0 ${
              link.isCurrent
                ? 'border-primary bg-primary'
                : link.revokedAt
                  ? 'border-destructive/50 bg-destructive/10'
                  : link.expiresAt && new Date(link.expiresAt) < new Date()
                    ? 'border-amber-500/50 bg-amber-500/10'
                    : 'border-border bg-muted'
            }`} />

            {/* Content */}
            <Link
              to={recordDetailPath(link.id)}
              className={`flex-1 rounded-lg border px-3 py-2 mb-2 transition-colors hover:bg-muted/50 ${
                link.isCurrent ? 'border-primary/30 bg-primary/5' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                {getStatusIcon(link)}
                <span className="text-sm font-medium truncate flex-1">
                  {link.isCurrent ? 'Current Version' : `Version ${link.versionNumber}`}
                </span>
                {getStatusBadge(link)}
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <div className="flex items-center gap-2 mt-1 ml-6">
                <FileText className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground truncate">{link.filename}</span>
                <span className="text-xs text-muted-foreground">
                  {new Date(link.createdAt).toLocaleDateString()}
                </span>
              </div>
              {link.expiresAt && (
                <div className="ml-6 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(link.expiresAt) < new Date()
                      ? `Expired ${new Date(link.expiresAt).toLocaleDateString()}`
                      : `Expires ${new Date(link.expiresAt).toLocaleDateString()}`}
                  </span>
                </div>
              )}
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
