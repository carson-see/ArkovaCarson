/**
 * Organization Onboarding Form (IDT WS4 enhanced)
 *
 * KYB-lite form for organization setup.
 * Captures legal name, display name, domain, and optional EIN/Tax ID.
 * EIN triggers verified org path; domain enables email verification later.
 */

import { useState, FormEvent } from 'react';
import { Building2, Globe, AlertCircle, Loader2, Hash, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { validateEin } from '@/lib/validators';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface OrgOnboardingFormProps {
  onSubmit: (data: {
    legalName: string;
    displayName: string;
    domain: string | null;
    einTaxId: string | null;
  }) => void;
  loading?: boolean;
  error?: string | null;
}

export function OrgOnboardingForm({
  onSubmit,
  loading = false,
  error,
}: Readonly<OrgOnboardingFormProps>) {
  const [legalName, setLegalName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [domain, setDomain] = useState('');
  const [einTaxId, setEinTaxId] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (!displayName.trim() && !legalName.trim()) {
      setValidationError('Organization name is required');
      return;
    }

    // Domain validation if provided
    if (domain.trim()) {
      const domainRegex = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
      if (!domainRegex.test(domain.toLowerCase())) {
        setValidationError('Please enter a valid domain (e.g., example.com)');
        return;
      }
    }

    // EIN validation if provided — must be XX-XXXXXXX format
    if (einTaxId.trim()) {
      const normalized = validateEin(einTaxId.trim());
      if (!normalized) {
        setValidationError('EIN must be in XX-XXXXXXX format (e.g., 12-3456789)');
        return;
      }
    }

    const effectiveDisplay = displayName.trim() || legalName.trim();
    onSubmit({
      legalName: legalName.trim() || effectiveDisplay,
      displayName: effectiveDisplay,
      domain: domain.trim().toLowerCase() || null,
      einTaxId: einTaxId.trim() || null,
    });
  };

  const displayError = validationError || error;

  return (
    <Card className="max-w-lg mx-auto">
      <CardHeader>
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 mb-4">
          <Building2 className="h-6 w-6 text-primary" />
        </div>
        <CardTitle>Set up your organization</CardTitle>
        <CardDescription>
          Enter your organization details to get started with Arkova
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {displayError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{displayError}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="displayName">
              Organization name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Acme Corp"
              required
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              The name shown throughout Arkova
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="legalName">Legal name</Label>
            <Input
              id="legalName"
              type="text"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Acme Corporation Inc."
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              Official registered business name (defaults to organization name)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="domain">Company domain</Label>
            <div className="relative">
              <Globe className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="domain"
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="acme.com"
                disabled={loading}
                className="pl-10"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Used for email domain verification and auto-joining members
            </p>
          </div>

          <Separator />

          {/* EIN / Tax ID for verified org path */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="einTaxId">EIN / Tax ID</Label>
              <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded flex items-center gap-1">
                <ShieldCheck className="h-3 w-3" />
                For verified badge
              </span>
            </div>
            <div className="relative">
              <Hash className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="einTaxId"
                type="text"
                value={einTaxId}
                onChange={(e) => setEinTaxId(e.target.value)}
                placeholder="XX-XXXXXXX (optional)"
                disabled={loading}
                className="pl-10"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Provide your EIN or tax identification number to earn a verified organization badge.
              You can also add this later in organization settings.
            </p>
          </div>

          <Button type="submit" className="w-full" size="lg" disabled={loading}>
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating organization...
              </>
            ) : (
              'Create organization'
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
