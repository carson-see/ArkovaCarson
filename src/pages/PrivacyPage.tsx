/**
 * Privacy Policy Page
 *
 * Public route at /privacy. Placeholder content — to be replaced with
 * legal-reviewed copy before production launch.
 */

import { Link } from 'react-router-dom';
import { Shield } from 'lucide-react';

export function PrivacyPage() {
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
        <h1 className="text-3xl font-bold tracking-tight mb-8">Privacy Policy</h1>
        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6 text-sm text-muted-foreground">
          <p className="text-base text-foreground">
            <strong>Effective Date:</strong> March 2026
          </p>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">1. Information We Collect</h2>
            <p>
              Arkova collects only the minimum information necessary to provide our document
              verification service. This includes your email address, organization name, and
              account preferences. We do <strong>not</strong> collect, store, or process your
              documents — all document fingerprinting occurs entirely within your browser.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">2. How We Use Your Information</h2>
            <p>
              Your information is used to authenticate your account, manage your organization,
              process billing, and deliver the verification service. We do not sell or share your
              personal information with third parties for marketing purposes.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">3. Document Privacy</h2>
            <p>
              Documents are processed entirely on your device. Only a cryptographic fingerprint
              (a one-way mathematical representation) is sent to our servers. It is mathematically
              impossible to reconstruct your document from its fingerprint. Your files never leave
              your browser.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">4. Data Security</h2>
            <p>
              We implement industry-standard security measures including encryption in transit (TLS),
              row-level security on all database tables, and strict access controls. Our audit trail
              is append-only and tamper-evident.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">5. Data Retention</h2>
            <p>
              Verification records are retained for as long as your account is active. You may
              request deletion of your account and associated data by contacting us at{' '}
              <a href="mailto:support@arkova.ai" className="text-primary hover:underline">
                support@arkova.ai
              </a>.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-foreground">6. Contact</h2>
            <p>
              For privacy-related inquiries, contact us at{' '}
              <a href="mailto:privacy@arkova.ai" className="text-primary hover:underline">
                privacy@arkova.ai
              </a>.
            </p>
          </section>

          <p className="text-xs pt-6 border-t">
            This privacy policy is a placeholder and will be updated following legal review
            prior to production launch.
          </p>
        </div>
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4 text-xs text-muted-foreground">
          <span>&copy; {new Date().getFullYear()} Arkova</span>
          <nav className="flex gap-4">
            <Link to="/privacy" className="hover:text-foreground transition-colors font-medium">Privacy</Link>
            <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
            <Link to="/contact" className="hover:text-foreground transition-colors">Contact</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
