/**
 * Pending Invitations List
 *
 * Surfaces the status of invitations that have not resulted in a member yet
 * — MembersTable only shows people who already joined, so a stuck invite
 * (spam-filtered, ignored, or expired before anyone ever opened it) was
 * previously invisible to the admin who sent it. Renders nothing once
 * loaded if there is nothing to show (no accepted invitations here — those
 * are already in MembersTable).
 */

import { useState, useCallback } from 'react';
import { Mail, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { PENDING_INVITATIONS_LABELS } from '@/lib/copy';
import type { InvitationDisplayStatus, OrgInvitation } from '@/hooks/useOrgInvitations';

interface PendingInvitationsListProps {
  invitations: OrgInvitation[];
  loading?: boolean;
  onResend?: (invitation: OrgInvitation) => Promise<void>;
}

const STATUS_BADGE: Record<InvitationDisplayStatus, { label: string; variant: 'warning' | 'destructive' | 'secondary' }> = {
  pending: { label: PENDING_INVITATIONS_LABELS.STATUS_PENDING, variant: 'warning' },
  expired: { label: PENDING_INVITATIONS_LABELS.STATUS_EXPIRED, variant: 'destructive' },
  revoked: { label: PENDING_INVITATIONS_LABELS.STATUS_REVOKED, variant: 'secondary' },
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function PendingInvitationsList({
  invitations,
  loading,
  onResend,
}: Readonly<PendingInvitationsListProps>) {
  const [resendingId, setResendingId] = useState<string | null>(null);

  const handleResend = useCallback(
    async (invitation: OrgInvitation) => {
      if (!onResend || resendingId) return;
      setResendingId(invitation.id);
      try {
        await onResend(invitation);
      } finally {
        setResendingId(null);
      }
    },
    [onResend, resendingId],
  );

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (invitations.length === 0) {
    return null;
  }

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
        <Mail className="h-4 w-4" />
        {PENDING_INVITATIONS_LABELS.SECTION_TITLE}
        <Badge variant="secondary" className="text-xs">{invitations.length}</Badge>
      </h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>{PENDING_INVITATIONS_LABELS.SENT_ON}</TableHead>
            <TableHead className="w-[100px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {invitations.map((invitation) => {
            const badge = STATUS_BADGE[invitation.displayStatus];
            const canResend = invitation.displayStatus !== 'revoked';
            const isResending = resendingId === invitation.id;
            return (
              <TableRow key={invitation.id}>
                <TableCell className="text-sm">{invitation.email}</TableCell>
                <TableCell>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(invitation.createdAt)}
                </TableCell>
                <TableCell>
                  {onResend && canResend && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isResending}
                      onClick={() => handleResend(invitation)}
                    >
                      {isResending ? (
                        <>
                          <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                          {PENDING_INVITATIONS_LABELS.RESENDING}
                        </>
                      ) : (
                        PENDING_INVITATIONS_LABELS.RESEND
                      )}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
