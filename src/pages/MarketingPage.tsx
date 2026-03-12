/**
 * Marketing Landing Page for Arkova
 *
 * Public-facing page at `/` for unauthenticated visitors.
 * Inspired by SimpleProof's clean, trust-forward design.
 *
 * Sections: Hero, How It Works, Features, Use Cases, Pricing, Trust, CTA, Footer
 */

import { Link } from 'react-router-dom';
import {
  Shield,
  FileCheck,
  Lock,
  Globe,
  ArrowRight,
  CheckCircle2,
  Fingerprint,
  Building2,
  GraduationCap,
  FileText,
  Award,
  Zap,
  Eye,
  Download,
  Users,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/routes';

// ---------------------------------------------------------------------------
// Pricing data (matches Stripe plans from PricingPage)
// ---------------------------------------------------------------------------
const PLANS = [
  {
    name: 'Starter',
    price: 'Free',
    period: '',
    description: 'For individuals getting started with document verification.',
    features: [
      '5 records per month',
      'Document fingerprinting',
      'Public verification links',
      'PDF proof certificates',
    ],
    cta: 'Get Started',
    highlighted: false,
  },
  {
    name: 'Professional',
    price: '$29',
    period: '/month',
    description: 'For professionals who need reliable document anchoring.',
    features: [
      '100 records per month',
      'Priority anchoring',
      'Credential metadata',
      'Bulk CSV upload',
      'Webhook notifications',
      'API access',
    ],
    cta: 'Start Free Trial',
    highlighted: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    description: 'For organizations with high-volume credentialing needs.',
    features: [
      'Unlimited records',
      'Dedicated support',
      'Custom integrations',
      'Organization management',
      'Audit reporting',
      'SLA guarantee',
    ],
    cta: 'Contact Sales',
    highlighted: false,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export function MarketingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 border-b border-gray-100 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <Shield className="h-7 w-7 text-[hsl(197,42%,66%)]" />
            <span className="text-xl font-bold text-[hsl(156,4%,19%)]">Arkova</span>
          </div>
          <div className="hidden items-center gap-8 md:flex">
            <a href="#how-it-works" className="text-sm text-gray-600 transition hover:text-gray-900">
              How It Works
            </a>
            <a href="#features" className="text-sm text-gray-600 transition hover:text-gray-900">
              Features
            </a>
            <a href="#pricing" className="text-sm text-gray-600 transition hover:text-gray-900">
              Pricing
            </a>
          </div>
          <div className="flex items-center gap-3">
            <Link to={ROUTES.LOGIN}>
              <Button variant="ghost" size="sm">
                Sign In
              </Button>
            </Link>
            <Link to={ROUTES.SIGNUP}>
              <Button size="sm" className="bg-[hsl(197,42%,66%)] hover:bg-[hsl(197,42%,56%)]">
                Get Started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden px-6 pb-20 pt-24 md:pt-32">
        <div className="absolute inset-0 bg-gradient-to-b from-[hsl(199,44%,97%)] to-white" />
        <div className="relative mx-auto max-w-4xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[hsl(197,42%,80%)] bg-[hsl(199,44%,95%)] px-4 py-1.5 text-sm text-[hsl(197,42%,40%)]">
            <Lock className="h-3.5 w-3.5" />
            Your documents never leave your device
          </div>
          <h1 className="mb-6 text-4xl font-bold tracking-tight text-[hsl(156,4%,19%)] md:text-6xl">
            Prove what matters.
            <br />
            <span className="text-[hsl(197,42%,66%)]">Permanently.</span>
          </h1>
          <p className="mx-auto mb-10 max-w-2xl text-lg text-gray-600 md:text-xl">
            Arkova creates tamper-proof records of your documents using cryptographic
            fingerprinting. Verify credentials, protect intellectual property, and
            establish provenance — without ever uploading your files.
          </p>
          <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link to={ROUTES.SIGNUP}>
              <Button size="lg" className="bg-[hsl(197,42%,66%)] px-8 hover:bg-[hsl(197,42%,56%)]">
                Start Securing Documents
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
            <a href="#how-it-works">
              <Button variant="outline" size="lg" className="px-8">
                See How It Works
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Trust bar */}
      <section className="border-y border-gray-100 bg-gray-50 px-6 py-8">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-x-12 gap-y-4 text-sm text-gray-500">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-[hsl(160,84%,39%)]" />
            Client-side processing only
          </div>
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-[hsl(160,84%,39%)]" />
            SHA-256 fingerprinting
          </div>
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-[hsl(160,84%,39%)]" />
            Independently verifiable
          </div>
          <div className="flex items-center gap-2">
            <FileCheck className="h-4 w-4 text-[hsl(160,84%,39%)]" />
            Permanent proof records
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-3xl font-bold text-[hsl(156,4%,19%)]">
              How It Works
            </h2>
            <p className="mx-auto max-w-2xl text-gray-600">
              Three simple steps to create a permanent, verifiable record of any document.
            </p>
          </div>
          <div className="grid gap-12 md:grid-cols-3">
            {[
              {
                step: '1',
                icon: Fingerprint,
                title: 'Upload & Fingerprint',
                description:
                  'Select your document. Arkova generates a unique SHA-256 fingerprint in your browser. The file never leaves your device.',
              },
              {
                step: '2',
                icon: Lock,
                title: 'Anchor & Secure',
                description:
                  'Your fingerprint is permanently anchored to a public, tamper-proof network. This creates an immutable timestamp proving the document existed at that moment.',
              },
              {
                step: '3',
                icon: CheckCircle2,
                title: 'Verify Anytime',
                description:
                  'Share a verification link or QR code. Anyone can independently confirm the authenticity and timestamp of your document — no account required.',
              },
            ].map((item) => (
              <div key={item.step} className="text-center">
                <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-[hsl(199,44%,95%)]">
                  <item.icon className="h-8 w-8 text-[hsl(197,42%,66%)]" />
                </div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[hsl(197,42%,66%)]">
                  Step {item.step}
                </div>
                <h3 className="mb-3 text-xl font-semibold text-[hsl(156,4%,19%)]">
                  {item.title}
                </h3>
                <p className="text-gray-600">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="bg-gray-50 px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-3xl font-bold text-[hsl(156,4%,19%)]">
              Everything You Need
            </h2>
            <p className="mx-auto max-w-2xl text-gray-600">
              Built for individuals, professionals, and organizations who need to prove document authenticity.
            </p>
          </div>
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: Shield,
                title: 'Privacy-First',
                description:
                  'Documents are fingerprinted in your browser. We never see, store, or transmit your files.',
              },
              {
                icon: Eye,
                title: 'Public Verification',
                description:
                  'Anyone can verify a credential via a shareable link or QR code — no account needed.',
              },
              {
                icon: Download,
                title: 'Proof Certificates',
                description:
                  'Download PDF proof packages with complete audit trails for compliance and legal use.',
              },
              {
                icon: Zap,
                title: 'Bulk Processing',
                description:
                  'Upload CSV files to anchor hundreds of credentials in a single batch operation.',
              },
              {
                icon: Users,
                title: 'Organization Tools',
                description:
                  'Manage team members, credential templates, and organization-wide records from one dashboard.',
              },
              {
                icon: Clock,
                title: 'Immutable Timestamps',
                description:
                  'Every record is anchored with a cryptographic timestamp that cannot be altered or backdated.',
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="rounded-xl border border-gray-200 bg-white p-6 transition hover:shadow-md"
              >
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(199,44%,95%)]">
                  <feature.icon className="h-5 w-5 text-[hsl(197,42%,66%)]" />
                </div>
                <h3 className="mb-2 font-semibold text-[hsl(156,4%,19%)]">{feature.title}</h3>
                <p className="text-sm text-gray-600">{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Use Cases */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-3xl font-bold text-[hsl(156,4%,19%)]">
              Built For
            </h2>
          </div>
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: GraduationCap,
                title: 'Education',
                description: 'Degrees, transcripts, and academic certifications.',
              },
              {
                icon: Building2,
                title: 'Organizations',
                description: 'Professional licenses, compliance certificates, and credentials.',
              },
              {
                icon: FileText,
                title: 'Legal & IP',
                description: 'Contracts, patents, and intellectual property records.',
              },
              {
                icon: Award,
                title: 'Professionals',
                description: 'Certifications, training records, and portfolio verification.',
              },
            ].map((useCase) => (
              <div key={useCase.title} className="text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-[hsl(199,44%,95%)]">
                  <useCase.icon className="h-7 w-7 text-[hsl(197,42%,66%)]" />
                </div>
                <h3 className="mb-2 font-semibold text-[hsl(156,4%,19%)]">{useCase.title}</h3>
                <p className="text-sm text-gray-600">{useCase.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="bg-gray-50 px-6 py-24">
        <div className="mx-auto max-w-5xl">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-3xl font-bold text-[hsl(156,4%,19%)]">
              Simple, Transparent Pricing
            </h2>
            <p className="mx-auto max-w-2xl text-gray-600">
              Start free. Scale as you grow. No hidden fees.
            </p>
          </div>
          <div className="grid gap-8 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`rounded-2xl border p-8 ${
                  plan.highlighted
                    ? 'border-[hsl(197,42%,66%)] bg-white shadow-lg ring-1 ring-[hsl(197,42%,66%)]'
                    : 'border-gray-200 bg-white'
                }`}
              >
                {plan.highlighted && (
                  <div className="mb-4 inline-block rounded-full bg-[hsl(199,44%,95%)] px-3 py-1 text-xs font-medium text-[hsl(197,42%,40%)]">
                    Most Popular
                  </div>
                )}
                <h3 className="text-xl font-bold text-[hsl(156,4%,19%)]">{plan.name}</h3>
                <div className="mt-4 flex items-baseline">
                  <span className="text-4xl font-bold text-[hsl(156,4%,19%)]">{plan.price}</span>
                  {plan.period && (
                    <span className="ml-1 text-gray-500">{plan.period}</span>
                  )}
                </div>
                <p className="mt-3 text-sm text-gray-600">{plan.description}</p>
                <Link to={ROUTES.SIGNUP} className="mt-6 block">
                  <Button
                    className={`w-full ${
                      plan.highlighted
                        ? 'bg-[hsl(197,42%,66%)] hover:bg-[hsl(197,42%,56%)]'
                        : ''
                    }`}
                    variant={plan.highlighted ? 'default' : 'outline'}
                  >
                    {plan.cta}
                  </Button>
                </Link>
                <ul className="mt-8 space-y-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm text-gray-600">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(160,84%,39%)]" />
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust / Security */}
      <section className="px-6 py-24">
        <div className="mx-auto max-w-4xl">
          <div className="rounded-2xl border border-gray-200 bg-gradient-to-br from-[hsl(199,44%,97%)] to-white p-12 text-center">
            <Shield className="mx-auto mb-6 h-12 w-12 text-[hsl(197,42%,66%)]" />
            <h2 className="mb-4 text-3xl font-bold text-[hsl(156,4%,19%)]">
              Your Privacy Is Our Architecture
            </h2>
            <p className="mx-auto mb-8 max-w-2xl text-gray-600">
              Arkova is built from the ground up so that your documents never leave your
              device. Fingerprinting happens entirely in your browser using the Web Crypto
              API. We anchor the fingerprint — never the file. This means even if our
              servers were compromised, your documents remain private.
            </p>
            <div className="grid gap-6 sm:grid-cols-3">
              {[
                { label: 'Zero-knowledge architecture', value: 'Privacy' },
                { label: 'SHA-256 Web Crypto API', value: 'Security' },
                { label: 'Append-only audit trail', value: 'Integrity' },
              ].map((item) => (
                <div key={item.value}>
                  <div className="text-2xl font-bold text-[hsl(197,42%,66%)]">{item.value}</div>
                  <div className="mt-1 text-sm text-gray-600">{item.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-[hsl(156,4%,19%)] px-6 py-24 text-center">
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-4 text-3xl font-bold text-white">
            Ready to start proving what matters?
          </h2>
          <p className="mb-8 text-lg text-gray-300">
            Create your free account and secure your first document in under a minute.
          </p>
          <Link to={ROUTES.SIGNUP}>
            <Button
              size="lg"
              className="bg-[hsl(197,42%,66%)] px-10 text-white hover:bg-[hsl(197,42%,56%)]"
            >
              Get Started Free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white px-6 py-12">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-col items-center justify-between gap-6 md:flex-row">
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-[hsl(197,42%,66%)]" />
              <span className="font-semibold text-[hsl(156,4%,19%)]">Arkova</span>
            </div>
            <div className="flex gap-6 text-sm text-gray-500">
              <Link to="/privacy" className="transition hover:text-gray-900">
                Privacy
              </Link>
              <Link to="/terms" className="transition hover:text-gray-900">
                Terms
              </Link>
              <Link to="/contact" className="transition hover:text-gray-900">
                Contact
              </Link>
              <Link to="/verify" className="transition hover:text-gray-900">
                Verify a Credential
              </Link>
            </div>
          </div>
          <div className="mt-8 text-center text-xs text-gray-400">
            &copy; {new Date().getFullYear()} Arkova. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
