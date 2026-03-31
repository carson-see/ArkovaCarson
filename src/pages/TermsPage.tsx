/**
 * Terms of Service Page
 *
 * Public route at /terms. Placeholder content — to be replaced with
 * legal-reviewed copy before production launch.
 */

import { Link } from 'react-router-dom';
import { Shield } from 'lucide-react';
import { usePageMeta } from '@/hooks/usePageMeta';

export function TermsPage() {
  usePageMeta({
    title: 'Terms of Service — Arkova Document Verification Platform',
    description: 'Arkova terms of service. Usage terms for the document verification platform, API, and credential anchoring services.',
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            <span className="font-semibold">Arkova</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight mb-8">Terms of Service</h1>
        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6 text-sm text-muted-foreground">
          <p className="text-base text-foreground">
            <strong>Effective Date:</strong> March 2026
          </p>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">1. Acceptance of Terms</h2>
            <p>
              By accessing or using Arkova, you agree to be bound by these Terms of Service.
              If you do not agree, do not use the service. Arkova reserves the right to update
              these terms at any time with notice to registered users.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">2. Description of Service</h2>
            <p>
              Arkova provides a document verification platform that creates tamper-evident
              records of documents using cryptographic fingerprinting. Documents are processed
              entirely on the user&apos;s device. Only cryptographic fingerprints are stored and
              anchored to a public network for independent verification.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">3. User Responsibilities</h2>
            <p>
              You are responsible for maintaining the confidentiality of your account credentials,
              ensuring the accuracy of information you provide, and complying with all applicable
              laws and regulations in your jurisdiction.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">4. Verification Scope</h2>
            <p>
              Arkova verifies that a document existed in a specific form at a specific time.
              Arkova does <strong>not</strong> verify the truthfulness, accuracy, or legal validity
              of document contents. Verification records confirm document integrity, not document
              merit.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">5. Subscription and Billing</h2>
            <p>
              Paid plans are billed on a recurring basis. You may upgrade, downgrade, or cancel
              your subscription at any time. Downgrades take effect at the end of the current
              billing period. Refunds are handled on a case-by-case basis.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">6. Limitation of Liability</h2>
            <p>
              Arkova is provided &quot;as is&quot; without warranty of any kind. To the maximum extent
              permitted by law, Arkova shall not be liable for any indirect, incidental, or
              consequential damages arising from your use of the service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">7. Contact</h2>
            <p>
              For questions about these terms, contact us at{' '}
              <a href="mailto:legal@arkova.ai" className="text-primary hover:underline">
                legal@arkova.ai
              </a>.
            </p>
          </section>

          <p className="text-xs pt-6 border-t">
            These terms of service are a placeholder and will be updated following legal review
            prior to production launch.
          </p>
        </div>
      </main>
      <footer className="border-t">
        <div className="mx-auto max-w-3xl px-6 py-6">
          <nav className="flex flex-wrap justify-center gap-4 text-xs text-muted-foreground mb-3" aria-label="Site navigation">
            <Link to="/about" className="hover:text-foreground transition-colors">About</Link>
            <Link to="/search" className="hover:text-foreground transition-colors">Search Credentials</Link>
            <Link to="/verify" className="hover:text-foreground transition-colors">Verify</Link>
            <Link to="/developers" className="hover:text-foreground transition-colors">Developers</Link>
            <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <Link to="/contact" className="hover:text-foreground transition-colors">Contact</Link>
          </nav>
          <p className="text-center text-xs text-muted-foreground">&copy; {new Date().getFullYear()} Arkova</p>
        </div>
      </footer>
    </div>
  );
}
