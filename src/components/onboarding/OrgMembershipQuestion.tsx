/**
 * Organization Membership Question Component (BUG-11)
 *
 * Asks Individual users during onboarding if they belong to an organization.
 * If yes, allows searching for and requesting to join an existing org.
 * If no, continues to plan selection.
 */

import { useState } from 'react';
import { Building2, ArrowRight, Search, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { ORG_MEMBERSHIP_LABELS } from '@/lib/copy';

interface OrgSearchResult {
  id: string;
  display_name: string;
  domain: string | null;
}

interface OrgMembershipQuestionProps {
  onSkip: () => void;
  onJoinOrg: (orgId: string) => void;
  loading?: boolean;
}

export function OrgMembershipQuestion({ onSkip, onJoinOrg, loading = false }: Readonly<OrgMembershipQuestionProps>) {
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<OrgSearchResult[]>([]);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearched(true);

    const query = searchQuery.trim().toLowerCase();
    const { data } = await supabase
      .from('organizations')
      .select('id, display_name, domain')
      .or(`display_name.ilike.%${query}%,domain.ilike.%${query}%`)
      .limit(5);

    setResults((data as OrgSearchResult[]) ?? []);
    setSearching(false);
  };

  if (!showSearch) {
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 mx-auto mb-4">
            <Building2 className="h-6 w-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">{ORG_MEMBERSHIP_LABELS.TITLE}</h1>
          <p className="text-muted-foreground max-w-md mx-auto">
            {ORG_MEMBERSHIP_LABELS.DESCRIPTION}
          </p>
        </div>

        <div className="space-y-3 max-w-sm mx-auto">
          <Button
            className="w-full"
            size="lg"
            onClick={() => setShowSearch(true)}
            disabled={loading}
          >
            {ORG_MEMBERSHIP_LABELS.YES_BUTTON}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="w-full"
            size="lg"
            onClick={onSkip}
            disabled={loading}
          >
            {ORG_MEMBERSHIP_LABELS.NO_BUTTON}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">{ORG_MEMBERSHIP_LABELS.TITLE}</h1>
      </div>

      <div className="space-y-4 max-w-md mx-auto">
        <div className="space-y-2">
          <Label htmlFor="orgSearch">{ORG_MEMBERSHIP_LABELS.SEARCH_LABEL}</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="orgSearch"
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder={ORG_MEMBERSHIP_LABELS.SEARCH_PLACEHOLDER}
                className="pl-10"
                disabled={searching}
              />
            </div>
            <Button onClick={handleSearch} disabled={searching || !searchQuery.trim()}>
              {searching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                'Search'
              )}
            </Button>
          </div>
        </div>

        {searched && results.length === 0 && !searching && (
          <p className="text-sm text-muted-foreground text-center">
            {ORG_MEMBERSHIP_LABELS.NO_ORG_FOUND}
          </p>
        )}

        {results.length > 0 && (
          <div className="space-y-2">
            {results.map((org) => (
              <Card key={org.id} className="cursor-pointer hover:border-primary/50 transition-all">
                <CardHeader className="py-3 px-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-sm">{org.display_name}</CardTitle>
                      {org.domain && (
                        <CardDescription className="text-xs">{org.domain}</CardDescription>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => onJoinOrg(org.id)}
                      disabled={loading}
                    >
                      {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        ORG_MEMBERSHIP_LABELS.JOIN_BUTTON
                      )}
                    </Button>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        )}

        <Button
          variant="ghost"
          className="w-full"
          onClick={onSkip}
          disabled={loading}
        >
          {ORG_MEMBERSHIP_LABELS.SKIP_BUTTON}
        </Button>
      </div>
    </div>
  );
}
