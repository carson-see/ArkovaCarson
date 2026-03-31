/**
 * About Page (GEO-04)
 *
 * Public route at /about. Team bios, mission, and structured data for GEO.
 * Includes Person JSON-LD schema with sameAs links for E-E-A-T signals.
 */

import { Link } from 'react-router-dom';
import { Building2, ExternalLink, Shield, Lightbulb, Globe } from 'lucide-react';
import { usePageMeta } from '@/hooks/usePageMeta';

const TEAM = [
  {
    name: 'Carson Seeger',
    role: 'CEO & Co-Founder',
    bio: 'Building the infrastructure layer for credential verification. Previously in enterprise software and fintech. Focused on making document authenticity provable and portable.',
    linkedin: 'https://www.linkedin.com/in/carson-s-8b41061a/',
    initials: 'CS',
  },
  {
    name: 'Sarah Rushton',
    role: 'COO & Co-Founder',
    bio: 'Operations and go-to-market strategy. Experience spanning international business development and organizational scaling. Based in Sydney, bringing a global perspective to credentialing.',
    linkedin: 'https://www.linkedin.com/in/sljrushton/',
    initials: 'SR',
  },
];

const ADVISORS = [
  {
    name: 'Dr. Yaacov Petscher',
    role: 'Co-Founder Advisor',
    bio: 'Academic credentialing domain expert with extensive publication record in psychometrics and education research.',
    link: 'https://scholar.google.com/citations?user=MUGWLDoAAAAJ&hl=en',
    linkLabel: 'Google Scholar',
    initials: 'YP',
  },
  {
    name: 'Dr. Periwinkle Doerfler',
    role: 'Technical Advisor',
    bio: 'Security architecture specialist. Reviews Arkova\'s cryptographic design, privacy architecture, and threat model.',
    link: 'https://www.linkedin.com/in/periwinkle-doerfler/',
    linkLabel: 'LinkedIn',
    initials: 'PD',
  },
];

function PersonSchema({ name, role, sameAs }: { name: string; role: string; sameAs: string }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Person',
          name,
          jobTitle: role,
          worksFor: {
            '@type': 'Organization',
            name: 'Arkova',
            url: 'https://arkova.ai',
          },
          sameAs,
        }),
      }}
    />
  );
}

export function AboutPage() {
  usePageMeta({
    title: 'About Arkova — Team, Mission & Document Verification Infrastructure',
    description: 'Meet the Arkova team building trust infrastructure for credentials. Privacy-first document verification with AI-powered extraction and cryptographic anchoring.',
  });

  return (
    <div className="min-h-screen bg-background">

      {/* Person schema for each team member */}
      {TEAM.map(m => (
        <PersonSchema key={m.name} name={m.name} role={m.role} sameAs={m.linkedin} />
      ))}
      {ADVISORS.map(a => (
        <PersonSchema key={a.name} name={a.name} role={a.role} sameAs={a.link} />
      ))}

      <header className="border-b">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Building2 className="h-4 w-4 text-primary" />
            </div>
            <span className="font-semibold">Arkova</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        {/* Hero */}
        <div className="mb-16">
          <h1 className="text-4xl font-bold tracking-tight mb-4">
            Building trust infrastructure for credentials
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl">
            Arkova makes document authenticity provable. We anchor credential fingerprints to a public network, creating an immutable record that anyone can verify — without exposing the document itself.
          </p>
        </div>

        {/* Traction — GEO-16: Social proof / metrics */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-16" aria-label="Platform metrics">
          <div className="p-5 rounded-xl border bg-card text-center">
            <p className="text-3xl font-bold text-primary">1.39M+</p>
            <p className="text-xs text-muted-foreground mt-1">Credentials Secured</p>
          </div>
          <div className="p-5 rounded-xl border bg-card text-center">
            <p className="text-3xl font-bold text-primary">320K+</p>
            <p className="text-xs text-muted-foreground mt-1">Public Records Indexed</p>
          </div>
          <div className="p-5 rounded-xl border bg-card text-center">
            <p className="text-3xl font-bold text-primary">21</p>
            <p className="text-xs text-muted-foreground mt-1">Credential Types</p>
          </div>
          <div className="p-5 rounded-xl border bg-card text-center">
            <p className="text-3xl font-bold text-primary">50+</p>
            <p className="text-xs text-muted-foreground mt-1">Jurisdictions Supported</p>
          </div>
        </section>

        {/* Mission cards */}
        <div className="grid md:grid-cols-3 gap-6 mb-16">
          <div className="p-6 rounded-xl border bg-card">
            <Shield className="h-8 w-8 text-primary mb-3" />
            <h3 className="font-semibold mb-2">Privacy by Design</h3>
            <p className="text-sm text-muted-foreground">
              Documents never leave the user's device. Only a cryptographic fingerprint is anchored — the original content stays private.
            </p>
          </div>
          <div className="p-6 rounded-xl border bg-card">
            <Lightbulb className="h-8 w-8 text-amber-400 mb-3" />
            <h3 className="font-semibold mb-2">AI-Powered Extraction</h3>
            <p className="text-sm text-muted-foreground">
              Intelligent metadata extraction recognizes credential types, issuers, dates, and fields — making verification searchable and structured.
            </p>
          </div>
          <div className="p-6 rounded-xl border bg-card">
            <Globe className="h-8 w-8 text-emerald-400 mb-3" />
            <h3 className="font-semibold mb-2">Universal Verification</h3>
            <p className="text-sm text-muted-foreground">
              Any credential, any issuer, any country. Our verification API lets third parties confirm document authenticity in real-time.
            </p>
          </div>
        </div>

        {/* Team */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold tracking-tight mb-6">Team</h2>
          <div className="grid md:grid-cols-2 gap-6">
            {TEAM.map(member => (
              <div key={member.name} className="flex gap-4 p-6 rounded-xl border bg-card">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-lg">
                  {member.initials}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{member.name}</h3>
                    <a
                      href={member.linkedin}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary transition-colors"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                  <p className="text-sm text-primary/80 mb-2">{member.role}</p>
                  <p className="text-sm text-muted-foreground">{member.bio}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Advisors */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold tracking-tight mb-6">Advisors</h2>
          <div className="grid md:grid-cols-2 gap-6">
            {ADVISORS.map(advisor => (
              <div key={advisor.name} className="flex gap-4 p-6 rounded-xl border bg-card">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground font-semibold text-lg">
                  {advisor.initials}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{advisor.name}</h3>
                    <a
                      href={advisor.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground hover:text-primary transition-colors text-xs"
                    >
                      {advisor.linkLabel} <ExternalLink className="inline h-3 w-3" />
                    </a>
                  </div>
                  <p className="text-sm text-primary/80 mb-2">{advisor.role}</p>
                  <p className="text-sm text-muted-foreground">{advisor.bio}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Contact */}
        <section>
          <h2 className="text-2xl font-bold tracking-tight mb-4">Get in Touch</h2>
          <p className="text-muted-foreground mb-4">
            Interested in Arkova for your organization? We'd love to hear from you.
          </p>
          <div className="flex flex-wrap gap-4">
            <a href="mailto:hello@arkova.ai" className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
              hello@arkova.ai
            </a>
            <Link to="/contact" className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline">
              Contact Page
            </Link>
            <a href="https://www.linkedin.com/company/arkovatech" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary transition-colors">
              LinkedIn <ExternalLink className="h-3 w-3" />
            </a>
            <a href="https://x.com/arkovatech" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary transition-colors">
              @arkovatech <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </section>
      </main>

      {/* GEO-17: Internal linking footer */}
      <footer className="border-t mt-16">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <nav className="flex flex-wrap justify-center gap-6 text-sm text-muted-foreground" aria-label="Site navigation">
            <Link to="/search" className="hover:text-primary transition-colors">Search Credentials</Link>
            <Link to="/verify" className="hover:text-primary transition-colors">Verify a Document</Link>
            <Link to="/developers" className="hover:text-primary transition-colors">Developer API</Link>
            <Link to="/contact" className="hover:text-primary transition-colors">Contact</Link>
            <Link to="/privacy" className="hover:text-primary transition-colors">Privacy</Link>
            <Link to="/terms" className="hover:text-primary transition-colors">Terms</Link>
          </nav>
          <p className="text-center text-xs text-muted-foreground mt-4">&copy; {new Date().getFullYear()} Arkova</p>
        </div>
      </footer>
    </div>
  );
}
