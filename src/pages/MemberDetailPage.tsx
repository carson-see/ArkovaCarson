/**
 * Member Detail Page
 *
 * Shows a member's profile info and all anchors they created
 * within the current user's organization.
 *
 * Route: /organization/member/:memberId
 */

import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Mail,
  Shield,
  Calendar,
  User,
  FileText,
  Loader2,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useOrganization } from '@/hooks/useOrganization';
import { supabase } from '@/lib/supabase';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchMemberData = useCallback(async () => {
    if (!memberId || !profile?.org_id) return;

    setLoading(true);
    setError(null);

    // Fetch member profile — must be in same org
    const { data: memberData, error: memberError } = await supabase
      .from('profiles')
      .select('id, email, full_name, avatar_url, role, created_at, org_id')
      .eq('id', memberId)
      .eq('org_id', profile.org_id)
      .single();

    if (memberError || !memberData) {
      setError(MEMBER_DETAIL_LABELS.MEMBER_NOT_FOUND);
      setLoading(false);
      return;
    }

    setMember(memberData as MemberProfile);

    // Fetch anchors created by this member within the org
    const { data: anchorData } = await supabase
      .from('anchors')
      .select('*')
      .eq('user_id', memberId)
      .eq('org_id', profile.org_id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    setAnchors(anchorData ?? []);
    setLoading(false);
  }, [memberId, profile?.org_id]);

  useEffect(() => {
    fetchMemberData();
  }, [fetchMemberData]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

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
                          <><Shield className="mr-1 h-3 w-3" />Admin</>
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

          {/* Member's records */}
          <Card className="shadow-card-rest">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="h-5 w-5" />
                {MEMBER_DETAIL_LABELS.RECORDS_SECTION}
                {anchors.length > 0 && (
                  <Badge variant="secondary">{anchors.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              {anchors.length === 0 ? (
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
                    {anchors.map((anchor) => (
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
