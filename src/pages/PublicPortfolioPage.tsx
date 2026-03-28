/**
 * Public Portfolio Page (ATT-05)
 *
 * Public-facing page to view a credential portfolio without authentication.
 * Displays attestations and anchored records bundled by the portfolio owner.
 * Accessed via /portfolio/:portfolioId.
 */

import { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Shield,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Clock,
  Loader2,
  ExternalLink,
  Copy,
  Check,
  Briefcase,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ROUTES, getAppBaseUrl } from '@/lib/routes';
import { supabase } from '@/lib/supabase';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = supabase as any;

interface Portfolio {
  id: string;
  public_id: string;
  title: string;
  attestation_ids: string[];
  anchor_ids: string[];
  expires_at: string | null;
  created_at: string;
}

interface AttestationItem {
  id: string;
  public_id: string;
  attestation_type: string;
  status: string;
  subject_identifier: string;
  attester_name: string;
  claims: Array<{ claim: string; evidence?: string }>;
  chain_tx_id: string | null;
  issued_at: string;
  expires_at: string | null;
}

interface AnchorItem {
  id: string;
  public_id: string;
  credential_type: string;
  status: string;
  chain_tx_id: string | null;
  created_at: string;
}

type PageState = 'loading' | 'not_found' | 'expired' | 'loaded';

const STATUS_ICON: Record<string, React.ReactNode> = {
  ACTIVE: <CheckCircle className="h-4 w-4 text-emerald-400" />,
  SECURED: <CheckCircle className="h-4 w-4 text-emerald-400" />,
  EXPIRED: <AlertTriangle className="h-4 w-4 text-yellow-400" />,
  REVOKED: <XCircle className="h-4 w-4 text-red-400" />,
  PENDING: <Clock className="h-4 w-4 text-amber-400" />,
  SUBMITTED: <Clock className="h-4 w-4 text-amber-400" />,
  DRAFT: <Clock className="h-4 w-4 text-muted-foreground" />,
};

const STATUS_BADGE: Record<string, string> = {
  ACTIVE: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  SECURED: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  EXPIRED: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
  REVOKED: 'bg-red-500/10 text-red-400 border-red-500/20',
  PENDING: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  SUBMITTED: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  DRAFT: 'bg-muted text-muted-foreground',
};

export function PublicPortfolioPage() {
  const { portfolioId } = useParams<{ portfolioId: string }>();
  const [state, setState] = useState<PageState>('loading');
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [attestations, setAttestations] = useState<AttestationItem[]>([]);
  const [anchors, setAnchors] = useState<AnchorItem[]>([]);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyToClipboard = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  }, []);

  useEffect(() => {
    if (!portfolioId) {
      setState('not_found');
      return;
    }

    async function load() {
      setState('loading');

      // Fetch portfolio
      const { data: pData, error: pError } = await dbAny
        .from('credential_portfolios')
        .select('*')
        .eq('public_id', portfolioId)
        .single();

      if (pError || !pData) {
        setState('not_found');
        return;
      }

      const p = pData as Portfolio;

      // Check expiry
      if (p.expires_at && new Date(p.expires_at) < new Date()) {
        setPortfolio(p);
        setState('expired');
        return;
      }

      setPortfolio(p);

      // Fetch attestations
      if (p.attestation_ids && p.attestation_ids.length > 0) {
        const { data: aData } = await dbAny
          .from('attestations')
          .select('id, public_id, attestation_type, status, subject_identifier, attester_name, claims, chain_tx_id, issued_at, expires_at')
          .in('id', p.attestation_ids);
        if (aData) setAttestations(aData as AttestationItem[]);
      }

      // Fetch anchors
      if (p.anchor_ids && p.anchor_ids.length > 0) {
        const { data: anData } = await dbAny
          .from('anchors')
          .select('id, public_id, credential_type, status, chain_tx_id, created_at')
          .in('id', p.anchor_ids);
        if (anData) setAnchors(anData as AnchorItem[]);
      }

      setState('loaded');
    }

    load();
  }, [portfolioId]);

  // Loading state
  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-[#00d4ff]" />
          <p className="text-sm text-muted-foreground">Loading portfolio...</p>
        </div>
      </div>
    );
  }

  // Not found state
  if (state === 'not_found') {
    return (
      <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center p-4">
        <Card className="max-w-md w-full border-red-500/20 bg-[#0d141b]/80">
          <CardContent className="flex flex-col items-center py-12">
            <XCircle className="h-12 w-12 text-red-400 mb-4" />
            <h2 className="text-xl font-semibold text-white mb-2">Portfolio Not Found</h2>
            <p className="text-sm text-muted-foreground text-center mb-6">
              This portfolio does not exist or has been removed.
            </p>
            <Link to={ROUTES.HOME}>
              <Button variant="outline" className="border-[#00d4ff]/20">
                Go Home
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Expired state
  if (state === 'expired' && portfolio) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center p-4">
        <Card className="max-w-md w-full border-yellow-500/20 bg-[#0d141b]/80">
          <CardContent className="flex flex-col items-center py-12">
            <AlertTriangle className="h-12 w-12 text-yellow-400 mb-4" />
            <h2 className="text-xl font-semibold text-white mb-2">Portfolio Expired</h2>
            <p className="text-sm text-muted-foreground text-center mb-2">
              This portfolio expired on {new Date(portfolio.expires_at!).toLocaleDateString()}.
            </p>
            <p className="text-xs text-muted-foreground text-center mb-6">
              Contact the portfolio owner for a new link.
            </p>
            <Link to={ROUTES.HOME}>
              <Button variant="outline" className="border-[#00d4ff]/20">
                Go Home
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!portfolio) return null;

  const totalItems = attestations.length + anchors.length;
  const verifiedCount = attestations.filter(a => a.status === 'ACTIVE').length +
    anchors.filter(a => a.status === 'SECURED').length;

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white">
      {/* Header */}
      <div className="border-b border-[#00d4ff]/10 bg-[#0d141b]/60">
        <div className="max-w-4xl mx-auto px-4 py-6 md:py-8">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Briefcase className="h-5 w-5 text-[#00d4ff]" />
                <span className="text-xs text-[#00d4ff] font-medium uppercase tracking-wider">
                  Credential Portfolio
                </span>
              </div>
              <h1 className="text-2xl md:text-3xl font-bold font-display tracking-tight">
                {portfolio.title}
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Created {new Date(portfolio.created_at).toLocaleDateString()} &middot; {totalItems} item{totalItems !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {verifiedCount === totalItems && totalItems > 0 ? (
                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                  <CheckCircle className="h-3 w-3 mr-1" /> All Verified
                </Badge>
              ) : (
                <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20">
                  {verifiedCount}/{totalItems} Verified
                </Badge>
              )}
            </div>
          </div>

          {/* Expiry notice */}
          {portfolio.expires_at && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              Expires {new Date(portfolio.expires_at).toLocaleDateString()}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Attestations */}
        {attestations.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Shield className="h-5 w-5 text-[#00d4ff]" />
              Attestations ({attestations.length})
            </h2>
            <div className="space-y-3">
              {attestations.map((att) => (
                <Card key={att.id} className="border-[#00d4ff]/10 bg-[#0d141b]/60">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {STATUS_ICON[att.status] || <Clock className="h-4 w-4 text-muted-foreground" />}
                          <span className="font-medium text-sm">{att.subject_identifier}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className="text-xs border-[#00d4ff]/20">
                            {att.attestation_type}
                          </Badge>
                          <Badge className={STATUS_BADGE[att.status] || 'bg-muted text-muted-foreground'}>
                            {att.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">
                          Attested by: {att.attester_name}
                        </p>
                        {/* Claims */}
                        {att.claims && att.claims.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {att.claims.map((c, i) => (
                              <div key={i} className="text-xs text-muted-foreground flex items-start gap-1">
                                <CheckCircle className="h-3 w-3 text-emerald-400 mt-0.5 shrink-0" />
                                <span>{c.claim}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {/* Chain proof */}
                        {att.chain_tx_id && (
                          <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                            <Shield className="h-3 w-3 text-[#00d4ff]" />
                            <span>Network Receipt: </span>
                            <code className="text-[#00d4ff] font-mono text-[10px]">
                              {att.chain_tx_id.slice(0, 12)}...{att.chain_tx_id.slice(-8)}
                            </code>
                          </div>
                        )}
                      </div>
                      <div className="ml-4 shrink-0">
                        <Link to={`/verify/attestation/${att.public_id}`}>
                          <Button variant="ghost" size="sm" className="text-[#00d4ff] hover:text-[#00d4ff]/80">
                            <ExternalLink className="h-3 w-3 mr-1" /> Verify
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Anchored Records */}
        {anchors.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
              <Shield className="h-5 w-5 text-[#00d4ff]" />
              Anchored Records ({anchors.length})
            </h2>
            <div className="space-y-3">
              {anchors.map((anc) => (
                <Card key={anc.id} className="border-[#00d4ff]/10 bg-[#0d141b]/60">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {STATUS_ICON[anc.status] || <Clock className="h-4 w-4 text-muted-foreground" />}
                          <span className="font-mono text-sm">{anc.public_id}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs border-[#00d4ff]/20">
                            {anc.credential_type || 'Document'}
                          </Badge>
                          <Badge className={STATUS_BADGE[anc.status] || 'bg-muted text-muted-foreground'}>
                            {anc.status}
                          </Badge>
                        </div>
                        {anc.chain_tx_id && (
                          <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                            <Shield className="h-3 w-3 text-[#00d4ff]" />
                            <span>Network Receipt: </span>
                            <code className="text-[#00d4ff] font-mono text-[10px]">
                              {anc.chain_tx_id.slice(0, 12)}...{anc.chain_tx_id.slice(-8)}
                            </code>
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">
                          Anchored {new Date(anc.created_at).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="ml-4 shrink-0">
                        <Link to={`/verify/${anc.public_id}`}>
                          <Button variant="ghost" size="sm" className="text-[#00d4ff] hover:text-[#00d4ff]/80">
                            <ExternalLink className="h-3 w-3 mr-1" /> Verify
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        <Separator className="border-[#00d4ff]/10" />

        {/* Footer */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Portfolio ID:</span>
            <code className="font-mono text-[#00d4ff]">{portfolio.public_id}</code>
            <button
              onClick={() => copyToClipboard(portfolio.public_id, 'portfolio-id')}
              className="hover:text-white transition-colors"
            >
              {copiedField === 'portfolio-id' ? (
                <Check className="h-3 w-3 text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-[#00d4ff]/20 text-xs"
              onClick={() => copyToClipboard(
                `${getAppBaseUrl()}/portfolio/${portfolio.public_id}`,
                'share-url'
              )}
            >
              {copiedField === 'share-url' ? (
                <><Check className="h-3 w-3 mr-1 text-emerald-400" /> Copied</>
              ) : (
                <><Copy className="h-3 w-3 mr-1" /> Copy Link</>
              )}
            </Button>
            <Link to={ROUTES.HOME}>
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground">
                Powered by Arkova
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
