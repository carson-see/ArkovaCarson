/**
 * Member Detail Page
 *
 * Shows a member's profile info and all anchors they created
 * within the current user's organization.
 *
 * Route: /organization/member/:memberId
 */

import { useEffect, useState, type ReactNode } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Mail, Calendar, User, FileText, Folder as FolderIcon, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useOrganization } from '@/hooks/useOrganization';
import { supabase } from '@/lib/supabase';
import { workerFetch } from '@/lib/workerClient';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ROUTES, recordDetailPath } from '@/lib/routes';
import {
  MEMBER_DETAIL_LABELS,
  ANCHOR_STATUS_LABELS,
  CREDENTIAL_TYPE_LABELS,
} from '@/lib/copy';
import type { Database } from '@/types/database.types';

type AnchorRow = Database['public']['Tables']['anchors']['Row'];

interface MemberProfile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  role: 'ORG_ADMIN' | 'INDIVIDUAL';
  created_at: string;
  org_id: string | null;
}

interface MemberFolder {
  id: string;
  name: string;
  parent_folder_id: string | null;
  connector_provider: 'google_drive' | 'docusign' | null;
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

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  PENDING: 'secondary',
  SECURED: 'default',
  REVOKED: 'destructive',
  EXPIRED: 'secondary',
};

export function MemberDetailPage() {
  const { memberId } = useParams<{ memberId: string }>();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { organization } = useOrganization(profile?.org_id);

  const [member, setMember] = useState<MemberProfile | null>(null);
  const [anchors, setAnchors] = useState<AnchorRow[]>([]);
  const [folders, setFolders] = useState<MemberFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!memberId || !profile?.org_id) return;

    const currentMemberId = memberId;
    let cancelled = false;

    async function fetchMemberData() {
      setLoading(true);
      setError(null);
      setFolderError(null);
      setSelectedFolderId(null);

      // Profile RLS establishes exact-org or approved parent-admin visibility.
      const { data: memberData, error: memberError } = await supabase
        .from('profiles')
        .select('id, email, full_name, avatar_url, role, created_at, org_id')
        .eq('id', currentMemberId)
        .single();

      if (cancelled) return;

      if (memberError || !memberData) {
        setError(MEMBER_DETAIL_LABELS.MEMBER_NOT_FOUND);
        setLoading(false);
        return;
      }

      const visibleMember = memberData as MemberProfile;
      if (!visibleMember.org_id) {
        setError(MEMBER_DETAIL_LABELS.MEMBER_NOT_FOUND);
        setLoading(false);
        return;
      }
      setMember(visibleMember);

      // The folder endpoint applies the same exact context and approved
      // ancestor-admin policy atomically in the database.
      const [anchorResult, folderResponse] = await Promise.all([
        supabase
        .from('anchors')
        .select('id, filename, fingerprint, status, credential_type, label, public_id, file_size, folder_id, created_at, updated_at, chain_timestamp, chain_tx_id, chain_block_height')
        .eq('user_id', currentMemberId)
        .eq('org_id', visibleMember.org_id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(200),
        workerFetch(`/api/v1/folders?owner_scope=USER&owner_user_id=${encodeURIComponent(currentMemberId)}&context_org_id=${encodeURIComponent(visibleMember.org_id)}`),
      ]);

      if (cancelled) return;

      setAnchors((anchorResult.data ?? []) as AnchorRow[]);
      if (folderResponse.ok) {
        const body = await folderResponse.json() as { folders?: MemberFolder[] };
        if (!cancelled) setFolders(body.folders ?? []);
      } else {
        setFolderError('Folders could not be loaded for this member.');
      }
      setLoading(false);
    }

    fetchMemberData();

    return () => { cancelled = true; };
  }, [memberId, profile?.org_id]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const selectedFolderIds = new Set<string>();
  if (selectedFolderId) {
    selectedFolderIds.add(selectedFolderId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) {
        if (folder.parent_folder_id && selectedFolderIds.has(folder.parent_folder_id) && !selectedFolderIds.has(folder.id)) {
          selectedFolderIds.add(folder.id);
          changed = true;
        }
      }
    }
  }
  const visibleAnchors = selectedFolderId
    ? anchors.filter((anchor) => !!anchor.folder_id && selectedFolderIds.has(anchor.folder_id))
    : anchors;

  const renderFolders = (parentId: string | null, depth = 0): ReactNode => folders
    .filter((folder) => folder.parent_folder_id === parentId)
    .map((folder) => (
      <div key={folder.id}>
        <button
          type="button"
          onClick={() => setSelectedFolderId(folder.id)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${selectedFolderId === folder.id ? 'bg-muted font-medium' : ''}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{folder.name}</span>
          {folder.connector_provider && <Badge variant="outline" className="ml-auto text-[10px]">Connector</Badge>}
        </button>
        {renderFolders(folder.id, depth + 1)}
      </div>
    ));

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
      orgName={organization?.display_name}
    >
      {/* Back button */}
      <div className="mb-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(ROUTES.ORGANIZATION)}
          className="gap-2 -ml-2 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {MEMBER_DETAIL_LABELS.BACK_TO_ORG}
        </Button>
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted mb-4">
            <User className="h-7 w-7 text-muted-foreground" />
          </div>
          <p className="text-muted-foreground">{error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => navigate(ROUTES.ORGANIZATION)}
          >
            {MEMBER_DETAIL_LABELS.BACK_TO_ORG}
          </Button>
        </div>
      )}

      {member && !loading && (
        <div className="space-y-6 animate-in-view">
          {/* Profile card */}
          <Card className="shadow-card-rest hover:shadow-card-hover transition-shadow">
            <CardHeader>
              <CardTitle className="text-lg">{MEMBER_DETAIL_LABELS.PROFILE_SECTION}</CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="pt-6">
              <div className="flex items-start gap-6">
                <Avatar className="h-20 w-20">
                  <AvatarImage src={member.avatar_url || undefined} />
                  <AvatarFallback className="bg-primary/10 text-primary text-xl">
                    {getInitials(member.full_name || member.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 space-y-4">
                  <div>
                    <h2 className="text-xl font-semibold">
                      {member.full_name || 'No name'}
                    </h2>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant={member.role === 'ORG_ADMIN' ? 'default' : 'secondary'}>
                        {member.role === 'ORG_ADMIN' ? (
                          <><ArkovaIcon className="mr-1 h-3 w-3" />Admin</>
                        ) : 'Member'}
                      </Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="flex items-center gap-2 text-sm">
                      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground">{MEMBER_DETAIL_LABELS.EMAIL}</p>
                        <p className="font-mono text-xs">{member.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground">{MEMBER_DETAIL_LABELS.JOINED}</p>
                        <p>{formatDate(member.created_at)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <User className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div>
                        <p className="text-xs text-muted-foreground">{MEMBER_DETAIL_LABELS.MEMBER_ID}</p>
                        <p className="font-mono text-xs">{member.id.slice(0, 8)}...</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-card-rest">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FolderIcon className="h-5 w-5" />
                Folders
                {folders.length > 0 && <Badge variant="secondary">{folders.length}</Badge>}
              </CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              <button
                type="button"
                onClick={() => setSelectedFolderId(null)}
                className={`mb-1 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted ${selectedFolderId === null ? 'bg-muted font-medium' : ''}`}
              >
                <span>All records</span>
                <Badge variant="secondary">{anchors.length}</Badge>
              </button>
              {folderError ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">{folderError}</p>
              ) : folders.length === 0 ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">No org-context folders.</p>
              ) : renderFolders(null)}
            </CardContent>
          </Card>

          {/* Member's records */}
          <Card className="shadow-card-rest">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-5 w-5" />
                {MEMBER_DETAIL_LABELS.RECORDS_SECTION}
                {visibleAnchors.length > 0 && (
                  <Badge variant="secondary">{visibleAnchors.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              {visibleAnchors.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <FileText className="h-10 w-10 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">{MEMBER_DETAIL_LABELS.RECORDS_EMPTY}</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleAnchors.map((anchor) => (
                      <TableRow key={anchor.id}>
                        <TableCell>
                          <Link
                            to={recordDetailPath(anchor.id)}
                            className="text-sm font-medium hover:text-primary transition-colors underline-offset-4 hover:underline"
                          >
                            {anchor.filename}
                          </Link>
                          <p className="font-mono text-xs text-muted-foreground mt-0.5">
                            {anchor.fingerprint.slice(0, 16)}...
                          </p>
                        </TableCell>
                        <TableCell>
                          {anchor.credential_type && (
                            <Badge variant="outline" className="text-xs">
                              {CREDENTIAL_TYPE_LABELS[anchor.credential_type as keyof typeof CREDENTIAL_TYPE_LABELS] ?? anchor.credential_type}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[anchor.status] ?? 'secondary'}>
                            {ANCHOR_STATUS_LABELS[anchor.status as keyof typeof ANCHOR_STATUS_LABELS] ?? anchor.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {formatDate(anchor.created_at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
