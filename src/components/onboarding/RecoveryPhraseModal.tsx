/**
 * RecoveryPhraseModal — Task SCRUM-IDT-TASK4
 *
 * Step-by-step modal that:
 *   1. Generates a 12-word recovery phrase client-side
 *   2. Displays it for the user to save
 *   3. Requires confirmation before proceeding ("I've saved my phrase")
 *   4. Calls onConfirm(claimKeyHash) once the user is ready to claim
 *
 * The phrase NEVER leaves the browser. Only the SHA-256 claim_key_hash
 * is passed to the parent for DB storage (Constitution 1.6).
 */

import { useState, useEffect, useCallback } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Copy, CheckCircle, AlertTriangle, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { generateRecoveryPhrase, deriveClaimKeyHash } from '@/lib/recoveryPhrase';

interface RecoveryPhraseModalProps {
  open: boolean;
  onConfirm: (claimKeyHash: string) => void;
  onCancel?: () => void;
}

export function RecoveryPhraseModal({
  open,
  onConfirm,
  onCancel,
}: Readonly<RecoveryPhraseModalProps>) {
  const [words, setWords] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'generate' | 'confirm'>('generate');

  // Generate phrase when modal opens
  useEffect(() => {
    if (open) {
      setWords(generateRecoveryPhrase());
      setConfirmed(false);
      setCopied(false);
      setRevealed(false);
      setStep('generate');
    }
  }, [open]);

  const handleRegenerate = useCallback(() => {
    setWords(generateRecoveryPhrase());
    setCopied(false);
    setConfirmed(false);
    setRevealed(false);
  }, []);

  const handleCopy = useCallback(async () => {
    if (words.length === 0) return;
    await navigator.clipboard.writeText(words.join(' '));
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  }, [words]);

  const handleClaim = useCallback(async () => {
    if (!confirmed || words.length === 0) return;
    setLoading(true);
    try {
      const claimKey = await deriveClaimKeyHash(words);
      // Log claim event to console (client-side audit trail)
      console.info('[RecoveryPhrase] Claim signed. Derived key (first 16):', claimKey.slice(0, 16) + '...');
      onConfirm(claimKey);
    } finally {
      setLoading(false);
    }
  }, [confirmed, words, onConfirm]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel?.(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <ArkovaIcon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <DialogTitle>Secure your profile</DialogTitle>
              <DialogDescription className="text-xs">
                Recovery Key Generation — Step {step === 'generate' ? '1' : '2'} of 2
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {step === 'generate' && (
          <div className="space-y-4">
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                <strong>Save these 12 words in a secure location.</strong>{' '}
                They are the only way to recover access to your profile.
                They are generated on your device and never sent to Arkova.
              </AlertDescription>
            </Alert>

            {/* 12-word grid */}
            <div className="relative">
              <div className={cn(
                'grid grid-cols-3 gap-2 rounded-lg border bg-muted/30 p-3',
                !revealed && 'select-none'
              )}>
                {words.map((word, i) => (
                  <div
                    key={`${word}-${i}`}
                    className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1.5"
                  >
                    <span className="text-xs text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                    <span className={cn(
                      'text-sm font-mono font-medium',
                      !revealed && 'blur-sm pointer-events-none'
                    )}>
                      {word}
                    </span>
                  </div>
                ))}
              </div>
              {!revealed && (
                <div className="absolute inset-0 flex items-center justify-center rounded-lg">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setRevealed(true)}
                    className="gap-2"
                  >
                    <Eye className="h-4 w-4" />
                    Reveal phrase
                  </Button>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={!revealed}
                className="gap-2 flex-1"
              >
                {copied ? (
                  <><CheckCircle className="h-3.5 w-3.5 text-success" /> Copied!</>
                ) : (
                  <><Copy className="h-3.5 w-3.5" /> Copy phrase</>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRegenerate}
                title="Generate new phrase"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              {revealed && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRevealed(false)}
                  title="Hide phrase"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            <Button
              className="w-full"
              disabled={!revealed}
              onClick={() => setStep('confirm')}
            >
              I've saved my phrase — continue
            </Button>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <Alert>
              <AlertDescription className="text-xs">
                Confirming this action will claim your profile. Your recovery phrase
                is the only way to restore access if you lose your credentials.
              </AlertDescription>
            </Alert>

            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">
                Your recovery phrase (12 words)
              </p>
              <div className="grid grid-cols-3 gap-1">
                {words.map((word, i) => (
                  <Badge key={`${word}-${i}`} variant="outline" className="justify-start text-xs font-mono">
                    {i + 1}. {word}
                  </Badge>
                ))}
              </div>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border"
              />
              <span className="text-sm text-muted-foreground">
                I have securely stored my 12-word recovery phrase. I understand that
                Arkova cannot recover it for me if lost.
              </span>
            </label>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setStep('generate')}
                className="flex-1"
                disabled={loading}
              >
                Back
              </Button>
              <Button
                onClick={handleClaim}
                disabled={!confirmed || loading}
                className="flex-1"
              >
                {loading ? 'Claiming profile...' : 'Claim my profile'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
