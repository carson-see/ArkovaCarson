/**
 * Public Verification Page Component
 *
 * Public-facing page for verifying documents without authentication.
 * When accessed via /verify/:publicId, shows the verification result directly.
 * When accessed without a publicId, shows the verification form.
 */

import { Link, useParams } from 'react-router-dom';
import { Shield } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { VerificationForm } from '@/components/verify';
import { PublicVerification } from '@/components/verification/PublicVerification';
import { ROUTES } from '@/lib/routes';
import { VERIFICATION_LABELS } from '@/lib/copy';

export function PublicVerifyPage() {
  const { publicId } = useParams<{ publicId: string }>();

  return (
    <div className="min-h-screen flex flex-col bg-mesh-gradient">
      {/* Header */}
      <header className="border-b glass-header">
        <div className="container flex h-16 items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
              <Shield className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="text-lg font-semibold">Arkova</span>
          </div>
          <nav>
            <Link
              to={ROUTES.LOGIN}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 container py-12">
        <div className="max-w-2xl mx-auto">
          {publicId ? (
            /* Direct verification result via /verify/:publicId */
            <>
              <div className="text-center mb-8">
                <h1 className="text-3xl font-bold tracking-tight mb-3">
                  {VERIFICATION_LABELS.PAGE_TITLE}
                </h1>
              </div>
              <PublicVerification publicId={publicId} />
            </>
          ) : (
            /* Verification form when no publicId in URL */
            <>
              <div className="text-center mb-8">
                <h1 className="text-3xl font-bold tracking-tight mb-3">
                  {VERIFICATION_LABELS.PAGE_TITLE}
                </h1>
                <p className="text-muted-foreground">
                  {VERIFICATION_LABELS.PAGE_SUBTITLE}
                </p>
              </div>

              <Card className="glass-card shadow-card-rest">
                <CardHeader>
                  <CardTitle className="text-lg">{VERIFICATION_LABELS.FORM_TITLE}</CardTitle>
                  <CardDescription>
                    {VERIFICATION_LABELS.FORM_SUBTITLE}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <VerificationForm />
                </CardContent>
              </Card>

              <div className="mt-8 grid gap-4 sm:grid-cols-3">
                <InfoCard
                  title="Secure"
                  description="Documents are verified using cryptographic fingerprints"
                />
                <InfoCard
                  title="Private"
                  description="Your document never leaves your device during verification"
                />
                <InfoCard
                  title="Instant"
                  description="Get verification results in seconds"
                />
              </div>
            </>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t py-6">
        <div className="container flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-xs text-muted-foreground">
            Arkova - Secure Document Verification
          </p>
          <nav className="flex gap-4 text-xs text-muted-foreground">
            <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
            <Link to="/contact" className="hover:text-foreground transition-colors">Contact</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function InfoCard({ title, description }: Readonly<{ title: string; description: string }>) {
  return (
    <div className="rounded-lg border bg-card/70 p-4 text-center glass-card">
      <h3 className="font-medium mb-1">{title}</h3>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
