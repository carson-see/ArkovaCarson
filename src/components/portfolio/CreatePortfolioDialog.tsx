/**
 * Create Portfolio Dialog (ATT-05)
 *
 * Dialog for creating a shareable credential portfolio.
 * Allows selecting attestations and anchored records, setting a title and expiry.
 */

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';
import { getAppBaseUrl } from '@/lib/routes';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Shield,
  Loader2,
  Copy,
  Check,
  CheckCircle,
  Briefcase,
  ExternalLink,
} from 'lucide-react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dbAny = supabase as any;

interface AttestationOption {
  id: string;
  public_id: string;
  attestation_type: string;
  status: string;
  subject_identifier: string;
  attester_name: string;
}

interface AnchorOption {
  id: string;
  public_id: string;
  credential_type: string;
  status: string;
  created_at: string;
}

interface CreatePortfolioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (portfolioId: string) => void;
}

function generatePublicId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `PF-${result}`;
}

export function CreatePortfolioDialog({ open, onOpenChange, onCreated }: CreatePortfolioDialogProps) {
  const { user } = useAuth();

  const [title, setTitle] = useState('');
  const [expiry, setExpiry] = useState('permanent');
  const [selectedAttestationIds, setSelectedAttestationIds] = useState<Set<string>>(new Set());
  const [selectedAnchorIds, setSelectedAnchorIds] = useState<Set<string>>(new Set());

  const [attestations, setAttestations] = useState<AttestationOption[]>([]);
  const [anchors, setAnchors] = useState<AnchorOption[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Created state
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Load user's attestations and anchors when dialog opens
  useEffect(() => {
    if (!open || !user) return;

    // Reset state
    setTitle('');
    setExpiry('permanent');
    setSelectedAttestationIds(new Set());
    setSelectedAnchorIds(new Set());
    setError(null);
    setCreatedId(null);
    setCopied(false);

    async function loadItems() {
      setLoadingItems(true);

      const [attResult, ancResult] = await Promise.all([
        dbAny
          .from('attestations')
          .select('id, public_id, attestation_type, status, subject_identifier, attester_name')
          .eq('user_id', user!.id)
          .order('created_at', { ascending: false }),
        dbAny
          .from('anchors')
          .select('id, public_id, credential_type, status, created_at')
          .eq('user_id', user!.id)
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      if (attResult.data) setAttestations(attResult.data as AttestationOption[]);
      if (ancResult.data) setAnchors(ancResult.data as AnchorOption[]);
      setLoadingItems(false);
    }

    loadItems();
  }, [open, user]);

  const toggleAttestation = (id: string) => {
    setSelectedAttestationIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAnchor = (id: string) => {
    setSelectedAnchorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = async () => {
    if (!user) return;
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (selectedAttestationIds.size === 0 && selectedAnchorIds.size === 0) {
      setError('Select at least one attestation or record');
      return;
    }

    setSubmitting(true);
    setError(null);

    const publicId = generatePublicId();
    let expiresAt: string | null = null;
    if (expiry === '7d') {
      expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (expiry === '30d') {
      expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    }

    const { error: insertError } = await dbAny
      .from('credential_portfolios')
      .insert({
        public_id: publicId,
        user_id: user.id,
        title: title.trim(),
        attestation_ids: Array.from(selectedAttestationIds),
        anchor_ids: Array.from(selectedAnchorIds),
        expires_at: expiresAt,
      });

    setSubmitting(false);

    if (insertError) {
      setError(insertError.message || 'Failed to create portfolio');
      return;
    }

    setCreatedId(publicId);
    onCreated(publicId);
  };

  const shareUrl = createdId ? `${getAppBaseUrl()}/portfolio/${createdId}` : '';

  const copyShareUrl = () => {
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const totalSelected = selectedAttestationIds.size + selectedAnchorIds.size;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Briefcase className="h-5 w-5 text-[#00d4ff]" />
            {createdId ? 'Portfolio Created' : 'Create Credential Portfolio'}
          </DialogTitle>
          <DialogDescription>
            {createdId
              ? 'Your portfolio is ready to share.'
              : 'Bundle attestations and records into a shareable portfolio.'}
          </DialogDescription>
        </DialogHeader>

        {createdId ? (
          /* Success state */
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-emerald-400">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">Portfolio created successfully</span>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Shareable URL</Label>
              <div className="flex items-center gap-2 mt-1">
                <Input
                  value={shareUrl}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="sm" onClick={copyShareUrl}>
                  {copied ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-[#00d4ff]/20"
                onClick={() => window.open(`/portfolio/${createdId}`, '_blank')}
              >
                <ExternalLink className="h-3 w-3 mr-1" /> Preview
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          /* Form state */
          <div className="space-y-4 py-2">
            {/* Title */}
            <div>
              <Label htmlFor="portfolio-title">Title</Label>
              <Input
                id="portfolio-title"
                placeholder="e.g. Employment Verification Bundle"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1"
              />
            </div>

            {/* Expiry */}
            <div>
              <Label>Expires</Label>
              <Select value={expiry} onValueChange={setExpiry}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7d">7 days</SelectItem>
                  <SelectItem value="30d">30 days</SelectItem>
                  <SelectItem value="permanent">Never (permanent)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Attestations */}
            {loadingItems ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading your items...
              </div>
            ) : (
              <>
                {attestations.length > 0 && (
                  <div>
                    <Label className="flex items-center gap-1 mb-2">
                      <Shield className="h-3 w-3 text-[#00d4ff]" />
                      Attestations
                    </Label>
                    <div className="space-y-2 max-h-40 overflow-y-auto border border-border/50 rounded-md p-2">
                      {attestations.map((att) => (
                        <label
                          key={att.id}
                          className="flex items-center gap-2 cursor-pointer hover:bg-muted/20 rounded px-1 py-0.5"
                        >
                          <Checkbox
                            checked={selectedAttestationIds.has(att.id)}
                            onCheckedChange={() => toggleAttestation(att.id)}
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium truncate block">
                              {att.subject_identifier}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {att.attestation_type} &middot; {att.attester_name}
                            </span>
                          </div>
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${
                              att.status === 'ACTIVE'
                                ? 'border-emerald-500/20 text-emerald-400'
                                : 'border-border/50'
                            }`}
                          >
                            {att.status}
                          </Badge>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Anchored Records */}
                {anchors.length > 0 && (
                  <div>
                    <Label className="flex items-center gap-1 mb-2">
                      <Shield className="h-3 w-3 text-[#00d4ff]" />
                      Anchored Records
                    </Label>
                    <div className="space-y-2 max-h-40 overflow-y-auto border border-border/50 rounded-md p-2">
                      {anchors.map((anc) => (
                        <label
                          key={anc.id}
                          className="flex items-center gap-2 cursor-pointer hover:bg-muted/20 rounded px-1 py-0.5"
                        >
                          <Checkbox
                            checked={selectedAnchorIds.has(anc.id)}
                            onCheckedChange={() => toggleAnchor(anc.id)}
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-mono truncate block">
                              {anc.public_id}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {anc.credential_type || 'Document'} &middot; {new Date(anc.created_at).toLocaleDateString()}
                            </span>
                          </div>
                          <Badge
                            variant="outline"
                            className={`text-[10px] ${
                              anc.status === 'SECURED'
                                ? 'border-emerald-500/20 text-emerald-400'
                                : 'border-border/50'
                            }`}
                          >
                            {anc.status}
                          </Badge>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {attestations.length === 0 && anchors.length === 0 && (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No attestations or records found. Create some first.
                  </p>
                )}
              </>
            )}

            {/* Error */}
            {error && (
              <p className="text-xs text-red-400">{error}</p>
            )}

            {/* Footer */}
            <DialogFooter>
              <div className="flex items-center justify-between w-full">
                <span className="text-xs text-muted-foreground">
                  {totalSelected} item{totalSelected !== 1 ? 's' : ''} selected
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleCreate} disabled={submitting || totalSelected === 0}>
                    {submitting ? (
                      <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</>
                    ) : (
                      <><Briefcase className="h-4 w-4 mr-2" /> Create Portfolio</>
                    )}
                  </Button>
                </div>
              </div>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
