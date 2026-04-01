/**
 * Recovery Phrase Modal
 *
 * Displays a generated 12-word recovery phrase during account activation.
 * User must acknowledge they've saved the phrase before proceeding.
 */

import { useState, useEffect } from 'react';
import { Copy, CheckCircle, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { generateRecoveryPhrase } from '@/lib/recoveryPhrase';

interface RecoveryPhraseModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the generated phrase words once the user confirms */
  onConfirm: (phrase: string[]) => void;
}

export function RecoveryPhraseModal({
  open,
  onOpenChange,
  onConfirm,
}: RecoveryPhraseModalProps) {
  const [phrase, setPhrase] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  // Generate phrase once when modal opens
  useEffect(() => {
    if (open && phrase.length === 0) {
      setPhrase(generateRecoveryPhrase());
      setRevealed(false);
      setCopied(false);
      setAcknowledged(false);
    }
  }, [open, phrase.length]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(phrase.join(' '));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConfirm = () => {
    onConfirm(phrase);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-1">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
            </div>
            <DialogTitle>Save Your Recovery Phrase</DialogTitle>
          </div>
          <DialogDescription>
            Your recovery phrase is the only way to access your account if you lose
            your password. Write it down and store it somewhere safe — it will not
            be shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Phrase grid */}
          <div className="relative rounded-lg border bg-muted/50 p-4">
            <div className="grid grid-cols-3 gap-2">
              {phrase.map((word, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-md border bg-background px-3 py-2"
                >
                  <span className="w-4 text-right text-xs text-muted-foreground shrink-0">
                    {i + 1}.
                  </span>
                  <span
                    className={`text-sm font-mono font-medium select-all transition-all ${
                      revealed ? '' : 'blur-sm select-none pointer-events-none'
                    }`}
                  >
                    {word}
                  </span>
                </div>
              ))}
            </div>

            {/* Reveal overlay */}
            {!revealed && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60 backdrop-blur-sm">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevealed(true)}
                >
                  <Eye className="mr-2 h-4 w-4" />
                  Reveal Phrase
                </Button>
              </div>
            )}
          </div>

          {/* Actions */}
          {revealed && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setRevealed(false)}
              >
                <EyeOff className="mr-2 h-4 w-4" />
                Hide
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={handleCopy}
              >
                {copied ? (
                  <>
                    <CheckCircle className="mr-2 h-4 w-4 text-success" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy
                  </>
                )}
              </Button>
            </div>
          )}

          {/* Acknowledgement */}
          <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <input
              id="phrase-acknowledged"
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
            />
            <Label htmlFor="phrase-acknowledged" className="text-sm leading-snug cursor-pointer">
              I have written down my recovery phrase and stored it somewhere safe.
              I understand that Arkova cannot recover it for me.
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!acknowledged || !revealed}
          >
            Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
