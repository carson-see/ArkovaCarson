/**
 * Members Table Component
 *
 * Displays organization members with role and status.
 */

import { useState, useCallback } from 'react';
import { MoreHorizontal, UserMinus, Shield, User, Mail, Loader2, ArrowUpDown, Calendar } from 'lucide-react';
import { ORG_PAGE_LABELS } from '@/lib/copy';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

export interface Member {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  role: 'ORG_ADMIN' | 'INDIVIDUAL';
  joinedAt: string;
  status: 'active' | 'pending' | 'removed';
}

interface MembersTableProps {
  members: Member[];
  loading?: boolean;
  currentUserId?: string;
  onRemoveMember?: (member: Member) => Promise<void>;
  onChangeRole?: (member: Member, newRole: 'ORG_ADMIN' | 'INDIVIDUAL') => Promise<void>;
}

export function MembersTable({
  members,
  loading,
  currentUserId,
  onRemoveMember,
  onChangeRole,
}: Readonly<MembersTableProps>) {
  const [removingMember, setRemovingMember] = useState<Member | null>(null);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [changingRoleMemberId, setChangingRoleMemberId] = useState<string | null>(null);

  const handleRemove = useCallback(async () => {
    if (!removingMember || !onRemoveMember) return;

    setIsRemoving(true);
    try {
      await onRemoveMember(removingMember);
    } finally {
      setIsRemoving(false);
      setRemovingMember(null);
    }
  }, [removingMember, onRemoveMember]);

  if (loading) {
    return <MembersTableSkeleton />;
  }

  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
          <User className="h-7 w-7 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold mb-1">No members yet</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Invite team members to collaborate on securing documents.
        </p>
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Joined</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow key={member.id}>
              <TableCell>
                <button
                  type="button"
                  className="flex items-center gap-3 text-left rounded-md -m-1 p-1 hover:bg-muted/50 transition-colors cursor-pointer w-full"
                  onClick={() => setSelectedMember(member)}
                >
                  <Avatar className="h-8 w-8">
                    <AvatarImage src={member.avatarUrl || undefined} />
                    <AvatarFallback className="bg-primary/10 text-primary text-xs">
                      {getInitials(member.fullName || member.email)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium text-sm hover:text-primary transition-colors">
                      {member.fullName || 'No name'}
                      {member.id === currentUserId && (
                        <span className="ml-2 text-xs text-muted-foreground">(You)</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{member.email}</p>
                  </div>
                </button>
              </TableCell>
              <TableCell>
                <Badge variant={member.role === 'ORG_ADMIN' ? 'default' : 'secondary'}>
                  {member.role === 'ORG_ADMIN' ? (
                    <>
                      <Shield className="mr-1 h-3 w-3" />
                      Admin
                    </>
                  ) : (
                    'Member'
                  )}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge
                  variant={
                    ({ active: 'success', pending: 'warning' } as Record<string, 'success' | 'warning'>)[member.status] ?? 'secondary'
                  }
                >
                  {member.status.charAt(0).toUpperCase() + member.status.slice(1)}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(member.joinedAt)}
              </TableCell>
              <TableCell>
                {member.id !== currentUserId && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {onChangeRole && (
                        <DropdownMenuItem
                          disabled={changingRoleMemberId === member.id}
                          onClick={async () => {
                            if (changingRoleMemberId === member.id) return;
                            try {
                              setChangingRoleMemberId(member.id);
                              await onChangeRole(
                                member,
                                member.role === 'ORG_ADMIN' ? 'INDIVIDUAL' : 'ORG_ADMIN'
                              );
                            } finally {
                              setChangingRoleMemberId(null);
                            }
                          }}
                        >
                          <ArrowUpDown className="mr-2 h-4 w-4" />
                          {member.role === 'ORG_ADMIN' ? ORG_PAGE_LABELS.DEMOTE_TO_MEMBER : ORG_PAGE_LABELS.PROMOTE_TO_ADMIN}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem>
                        <Mail className="mr-2 h-4 w-4" />
                        Send message
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => setRemovingMember(member)}
                        className="text-destructive focus:text-destructive"
                      >
                        <UserMinus className="mr-2 h-4 w-4" />
                        Remove member
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Member detail dialog */}
      <Dialog open={!!selectedMember} onOpenChange={() => setSelectedMember(null)}>
        <DialogContent className="max-w-md">
          {selectedMember && (
            <>
              <DialogHeader>
                <DialogTitle>Member Details</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col items-center gap-3 py-4">
                <Avatar className="h-16 w-16">
                  <AvatarImage src={selectedMember.avatarUrl || undefined} />
                  <AvatarFallback className="bg-primary/10 text-primary text-lg">
                    {getInitials(selectedMember.fullName || selectedMember.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="text-center">
                  <p className="text-lg font-semibold">
                    {selectedMember.fullName || 'No name'}
                    {selectedMember.id === currentUserId && (
                      <span className="ml-2 text-xs text-muted-foreground font-normal">(You)</span>
                    )}
                  </p>
                  <p className="text-sm text-muted-foreground">{selectedMember.email}</p>
                </div>
                <div className="flex gap-2">
                  <Badge variant={selectedMember.role === 'ORG_ADMIN' ? 'default' : 'secondary'}>
                    {selectedMember.role === 'ORG_ADMIN' ? (
                      <><Shield className="mr-1 h-3 w-3" />Admin</>
                    ) : 'Member'}
                  </Badge>
                  <Badge
                    variant={
                      ({ active: 'success', pending: 'warning' } as Record<string, 'success' | 'warning'>)[selectedMember.status] ?? 'secondary'
                    }
                  >
                    {selectedMember.status.charAt(0).toUpperCase() + selectedMember.status.slice(1)}
                  </Badge>
                </div>
              </div>
              <Separator />
              <div className="space-y-3 py-2">
                <div className="flex items-center gap-3 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Email</p>
                    <p className="font-mono text-xs">{selectedMember.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Shield className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Role</p>
                    <p>{selectedMember.role === 'ORG_ADMIN' ? 'Organization Administrator' : 'Member'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Joined</p>
                    <p>{formatDate(selectedMember.joinedAt)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <User className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Member ID</p>
                    <p className="font-mono text-xs">{selectedMember.id.slice(0, 8)}...</p>
                  </div>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Remove confirmation dialog */}
      <AlertDialog open={!!removingMember} onOpenChange={() => setRemovingMember(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove{' '}
              <span className="font-medium text-foreground">
                {removingMember?.fullName || removingMember?.email}
              </span>{' '}
              from the organization? They will lose access to all organization records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              disabled={isRemoving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemoving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Removing...
                </>
              ) : (
                'Remove member'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function MembersTableSkeleton() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Member</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead className="w-[50px]"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 3 }).map((_, idx) => (
          <TableRow key={`skeleton-${idx}`}>
            <TableCell>
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="space-y-1">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </div>
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-16" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-5 w-14" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-20" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-8 w-8" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function getInitials(name: string): string {
  const parts = name.split(/[\s@]+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
