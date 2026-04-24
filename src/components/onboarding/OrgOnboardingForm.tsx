/**
 * Organization Onboarding Form (IDT WS4 enhanced)
 *
 * KYB-lite form for organization setup.
 * Captures legal name, display name, domain, and optional EIN/Tax ID.
 * EIN triggers verified org path; domain enables email verification later.
 */

import { useState, FormEvent } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Building2, Globe, AlertCircle, Loader2, Hash, MapPin, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { validateEin } from '@/lib/validators';
import { ORGANIZATION_TIER_METADATA } from '@/lib/onboardingPlans';
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
    organizationType: string | null;
    description: string | null;
    websiteUrl: string | null;
    linkedinUrl: string | null;
    twitterUrl: string | null;
    location: string | null;
    verifyOrganization: boolean;
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
  const [organizationType, setOrganizationType] = useState('');
  const [description, setDescription] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [twitterUrl, setTwitterUrl] = useState('');
  const [location, setLocation] = useState('');
  const [verifyOrganization, setVerifyOrganization] = useState(false);
  const [einTaxId, setEinTaxId] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const freeOrgTier = ORGANIZATION_TIER_METADATA.find((tier) => tier.id === 'org_free')
    ?? ORGANIZATION_TIER_METADATA[0];

  const validateOptionalUrl = (value: string, label: string): string | null => {
    if (!value.trim()) return null;
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return `${label} must start with http:// or https://`;
      }
      return null;
    } catch {
      return `${label} must be a valid URL`;
    }
  };

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
    if (verifyOrganization && !einTaxId.trim()) {
      setValidationError('EIN / Tax ID is required to verify your organization');
      return;
    }

    if (verifyOrganization && !location.trim()) {
      setValidationError('Business address or headquarters location is required to verify your organization');
      return;
    }

    if (einTaxId.trim()) {
      const normalized = validateEin(einTaxId.trim());
      if (!normalized) {
        setValidationError('EIN must be in XX-XXXXXXX format (e.g., 12-3456789)');
        return;
      }
    }

    const urlError = validateOptionalUrl(websiteUrl, 'Website')
      ?? validateOptionalUrl(linkedinUrl, 'LinkedIn profile')
      ?? validateOptionalUrl(twitterUrl, 'Social profile');
    if (urlError) {
      setValidationError(urlError);
      return;
    }

    const effectiveDisplay = displayName.trim() || legalName.trim();
    onSubmit({
      legalName: legalName.trim() || effectiveDisplay,
      displayName: effectiveDisplay,
      domain: domain.trim().toLowerCase() || null,
      organizationType: organizationType || null,
      description: description.trim() || null,
      websiteUrl: websiteUrl.trim() || null,
      linkedinUrl: linkedinUrl.trim() || null,
      twitterUrl: twitterUrl.trim() || null,
      location: location.trim() || null,
      verifyOrganization,
      einTaxId: verifyOrganization ? einTaxId.trim() || null : null,
    });
  };

  const displayError = validationError || error;

  return (
    <Card className="max-w-2xl mx-auto">
      <CardHeader>
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 mb-4">
          <Building2 className="h-6 w-6 text-primary" />
        </div>
        <CardTitle>Set up your organization</CardTitle>
        <CardDescription>
          Enter your organization details to create its Arkova workspace
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
            <Label htmlFor="organizationType">Organization type</Label>
            <Select value={organizationType} onValueChange={setOrganizationType} disabled={loading}>
              <SelectTrigger id="organizationType">
                <SelectValue placeholder="Select a type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="corporation">Company</SelectItem>
                <SelectItem value="small_business">Small business</SelectItem>
                <SelectItem value="university">University</SelectItem>
                <SelectItem value="government">Government</SelectItem>
                <SelectItem value="nonprofit">Nonprofit</SelectItem>
                <SelectItem value="law_firm">Law firm</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
              placeholder="Briefly describe what your organization does"
              rows={3}
              disabled={loading}
              className="resize-none"
            />
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="websiteUrl">Website</Label>
              <Input
                id="websiteUrl"
                type="url"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
                placeholder="https://example.com"
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="linkedinUrl">LinkedIn</Label>
              <Input
                id="linkedinUrl"
                type="url"
                value={linkedinUrl}
                onChange={(e) => setLinkedinUrl(e.target.value)}
                placeholder="https://linkedin.com/company/example"
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="twitterUrl">Social profile</Label>
            <Input
              id="twitterUrl"
              type="url"
              value={twitterUrl}
              onChange={(e) => setTwitterUrl(e.target.value)}
              placeholder="https://x.com/example"
              disabled={loading}
            />
          </div>

          <Separator />

          <div className="rounded-lg border p-4 space-y-4">
            <div className="flex items-start gap-3">
              <Checkbox
                id="verifyOrganization"
                checked={verifyOrganization}
                onCheckedChange={(checked) => setVerifyOrganization(checked === true)}
                disabled={loading}
              />
              <div className="space-y-1">
                <Label htmlFor="verifyOrganization" className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  Verify this organization
                </Label>
                <p className="text-xs text-muted-foreground">
                  Verified organizations receive a checkmark and tier-based access. Skip this for a{' '}
                  {freeOrgTier.includedSeats}-seat workspace with {freeOrgTier.anchorsPerMonth} anchors per month.
                </p>
              </div>
            </div>

            {verifyOrganization && (
              <div className="space-y-4 border-t pt-4">
                <div className="space-y-2">
                  <Label htmlFor="location">Business address or headquarters</Label>
                  <div className="relative">
                    <MapPin className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="location"
                      type="text"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="123 Main St, Detroit, MI"
                      disabled={loading}
                      className="pl-10"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="einTaxId">EIN / Tax ID</Label>
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded flex items-center gap-1">
                      <ArkovaIcon className="h-3 w-3" />
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
                      placeholder="12-3456789"
                      disabled={loading}
                      className="pl-10"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    EIN and address are used for organization verification and are not shown publicly.
                  </p>
                </div>
              </div>
            )}
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
