/**
 * Organization Onboarding Form
 *
 * KYB-lite form for organization setup.
 * Captures legal name, display name, and domain.
 */

import { useState, FormEvent } from 'react';
import { Building2, Globe, AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (!legalName.trim()) {
      setValidationError('Legal name is required');
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

    onSubmit({
      legalName: legalName.trim(),
      displayName: displayName.trim() || legalName.trim(),
      domain: domain.trim().toLowerCase() || null,
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
            <Label htmlFor="legalName">
              Legal name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="legalName"
              type="text"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="Acme Corporation Inc."
              required
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              Official registered business name
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="displayName">Display name</Label>
            <Input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Acme Corp"
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              Short name shown in the app (defaults to legal name)
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
              Used for email domain verification (optional)
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
