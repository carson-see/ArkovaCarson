/**
 * Profile Card Component
 *
 * User profile section for the dashboard combining:
 * - Avatar / PFP with upload placeholder
 * - Name + unique public ID
 * - Verified badge
 * - Privacy toggle (default ON = discoverable only by unique ID)
 * - Organization link (if user belongs to one)
 * - Social links (LinkedIn, Twitter, etc.)
 *
 * @see UAT Session 40 — Dashboard redesign
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, Globe, Lock, Linkedin, Twitter, ExternalLink, Camera } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { orgProfilePath } from '@/lib/routes';
import type { Database } from '@/types/database.types';

type Profile = Database['public']['Tables']['profiles']['Row'];

interface Organization {
  id: string;
  display_name: string;
  public_id?: string | null;
}

interface ProfileCardProps {
  profile: Profile | null;
  organization?: Organization | null;
  loading?: boolean;
  onTogglePrivacy: (isPublic: boolean) => void;
}

function parseSocialLinks(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, string>;
}

export function ProfileCard({ profile, organization, loading, onTogglePrivacy }: Readonly<ProfileCardProps>) {
  const [privacyUpdating, setPrivacyUpdating] = useState(false);

  if (loading || !profile) {
    return (
      <Card className="border-white/[0.06] bg-white/[0.015] mb-8">
        <CardContent className="p-6">
          <div className="flex items-start gap-5">
            <Skeleton className="h-20 w-20 rounded-full shrink-0" />
            <div className="space-y-3 flex-1">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-56" />
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const socials = parseSocialLinks(profile.social_links);
  const isPublic = profile.is_public_profile;
  const initials = profile.full_name
    ? profile.full_name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : (profile.email?.[0] ?? '?').toUpperCase();

  const handlePrivacyToggle = async (checked: boolean) => {
    setPrivacyUpdating(true);
    try {
      await onTogglePrivacy(checked);
    } finally {
      setPrivacyUpdating(false);
    }
  };

  return (
    <Card className="border-white/[0.06] bg-white/[0.015] mb-8">
      <CardContent className="p-6">
        <div className="flex flex-col sm:flex-row items-start gap-5">
          {/* Avatar */}
          <div className="relative group shrink-0">
            {profile.avatar_url ? (
              <img
                src={profile.avatar_url}
                alt={profile.full_name ?? 'Profile'}
                className="h-20 w-20 rounded-full object-cover border-2 border-white/[0.08]"
              />
            ) : (
              <div className="h-20 w-20 rounded-full bg-[#00d4ff]/[0.08] border-2 border-white/[0.08] flex items-center justify-center">
                <span className="text-xl font-semibold text-[#00d4ff]">{initials}</span>
              </div>
            )}
            <button
              className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer"
              aria-label="Change profile picture"
              onClick={() => {
                // TODO: avatar upload — wire to settings or in-place upload
              }}
            >
              <Camera className="h-5 w-5 text-white/80" />
            </button>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            {/* Name + Verified */}
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-bold text-foreground truncate">
                {profile.full_name ?? 'User'}
              </h2>
              {profile.is_verified && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#00d4ff]/[0.08] text-[#00d4ff] text-xs font-medium">
                        <BadgeCheck className="h-3.5 w-3.5" />
                        Verified
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Identity verified on Arkova</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>

            {/* Public ID */}
            {profile.public_id && (
              <p className="text-[13px] font-mono text-muted-foreground mt-0.5">
                {profile.public_id}
              </p>
            )}

            {/* Organization link */}
            {organization && (
              <Link
                to={orgProfilePath(organization.id)}
                className="inline-flex items-center gap-1.5 text-[13px] text-[#00d4ff] hover:text-[#00a3cc] transition-colors mt-1"
              >
                <ExternalLink className="h-3 w-3" />
                {organization.display_name}
              </Link>
            )}

            {/* Privacy + Socials row */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 mt-4">
              {/* Privacy toggle */}
              <div className="flex items-center gap-2">
                {isPublic ? (
                  <Globe className="h-4 w-4 text-[#00d4ff]" />
                ) : (
                  <Lock className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="text-[13px] text-muted-foreground">
                  {isPublic ? 'Public profile' : 'Private — ID only'}
                </span>
                <Switch
                  checked={isPublic}
                  onCheckedChange={handlePrivacyToggle}
                  disabled={privacyUpdating}
                  aria-label="Toggle profile visibility"
                  className="data-[state=checked]:bg-[#00d4ff]"
                />
              </div>

              {/* Social links */}
              {(socials.linkedin || socials.twitter) && (
                <div className="flex items-center gap-2">
                  {socials.linkedin && (
                    <a
                      href={socials.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-[#00d4ff] transition-colors"
                      aria-label="LinkedIn profile"
                    >
                      <Linkedin className="h-4 w-4" />
                    </a>
                  )}
                  {socials.twitter && (
                    <a
                      href={socials.twitter}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-[#00d4ff] transition-colors"
                      aria-label="Twitter profile"
                    >
                      <Twitter className="h-4 w-4" />
                    </a>
                  )}
                </div>
              )}

              {/* Add socials hint if none set */}
              {!socials.linkedin && !socials.twitter && (
                <Link
                  to="/settings"
                  className="text-[12px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                >
                  + Add social links
                </Link>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
