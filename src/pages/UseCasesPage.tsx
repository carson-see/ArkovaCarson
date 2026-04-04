/**
 * Use Cases Page (GEO-08)
 *
 * Public route at /use-cases. Showcases industry-specific use cases
 * with FAQ section. Includes FAQPage JSON-LD schema for SEO.
 */

import { Link } from 'react-router-dom';
import {
  Building2,
  GraduationCap,
  Scale,
  HeartPulse,
  Landmark,
  Users,
  Building,
  ChevronDown,
  ArrowRight,
} from 'lucide-react';
import { useState } from 'react';
import { usePageMeta } from '@/hooks/usePageMeta';
import { USE_CASES_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

const USE_CASES = [
  {
    icon: GraduationCap,
    title: USE_CASES_LABELS.EDUCATION_TITLE,
    description: USE_CASES_LABELS.EDUCATION_DESC,
    example: USE_CASES_LABELS.EDUCATION_EXAMPLE,
    color: 'text-blue-500',
    bg: 'bg-blue-500/10',
  },
  {
    icon: Scale,
    title: USE_CASES_LABELS.LEGAL_TITLE,
    description: USE_CASES_LABELS.LEGAL_DESC,
    example: USE_CASES_LABELS.LEGAL_EXAMPLE,
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
  },
  {
    icon: HeartPulse,
    title: USE_CASES_LABELS.HEALTHCARE_TITLE,
    description: USE_CASES_LABELS.HEALTHCARE_DESC,
    example: USE_CASES_LABELS.HEALTHCARE_EXAMPLE,
    color: 'text-rose-500',
    bg: 'bg-rose-500/10',
  },
  {
    icon: Landmark,
    title: USE_CASES_LABELS.FINANCE_TITLE,
    description: USE_CASES_LABELS.FINANCE_DESC,
    example: USE_CASES_LABELS.FINANCE_EXAMPLE,
    color: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
  },
  {
    icon: Users,
    title: USE_CASES_LABELS.HR_TITLE,
    description: USE_CASES_LABELS.HR_DESC,
    example: USE_CASES_LABELS.HR_EXAMPLE,
    color: 'text-purple-500',
    bg: 'bg-purple-500/10',
  },
  {
    icon: Building,
    title: USE_CASES_LABELS.GOVERNMENT_TITLE,
    description: USE_CASES_LABELS.GOVERNMENT_DESC,
    example: USE_CASES_LABELS.GOVERNMENT_EXAMPLE,
    color: 'text-slate-500',
    bg: 'bg-slate-500/10',
  },
];

const FAQS = [
  { question: USE_CASES_LABELS.FAQ_1_Q, answer: USE_CASES_LABELS.FAQ_1_A },
  { question: USE_CASES_LABELS.FAQ_2_Q, answer: USE_CASES_LABELS.FAQ_2_A },
  { question: USE_CASES_LABELS.FAQ_3_Q, answer: USE_CASES_LABELS.FAQ_3_A },
  { question: USE_CASES_LABELS.FAQ_4_Q, answer: USE_CASES_LABELS.FAQ_4_A },
  { question: USE_CASES_LABELS.FAQ_5_Q, answer: USE_CASES_LABELS.FAQ_5_A },
];

function FAQSchema() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: FAQS.map((faq) => ({
            '@type': 'Question',
            name: faq.question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: faq.answer,
            },
          })),
        }),
      }}
    />
  );
}

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b last:border-b-0">
      <button
        className="flex w-full items-center justify-between py-4 text-left font-medium hover:text-primary transition-colors"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span>{question}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <p className="pb-4 text-sm text-muted-foreground leading-relaxed">
          {answer}
        </p>
      )}
    </div>
  );
}

export function UseCasesPage() {
  usePageMeta({
    title: USE_CASES_LABELS.PAGE_TITLE,
    description: USE_CASES_LABELS.PAGE_DESCRIPTION,
  });

  return (
    <div className="min-h-screen bg-background">
      <FAQSchema />

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
        <div className="mb-16 text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-4">
            {USE_CASES_LABELS.HERO_TITLE}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {USE_CASES_LABELS.HERO_SUBTITLE}
          </p>
        </div>

        {/* Use case cards */}
        <section className="grid md:grid-cols-2 gap-6 mb-20" aria-label="Industry use cases">
          {USE_CASES.map((uc) => {
            const Icon = uc.icon;
            return (
              <div key={uc.title} className="p-6 rounded-xl border bg-card flex flex-col">
                <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${uc.bg} mb-4`}>
                  <Icon className={`h-5 w-5 ${uc.color}`} />
                </div>
                <h2 className="text-lg font-semibold mb-2">{uc.title}</h2>
                <p className="text-sm text-muted-foreground mb-3 flex-1">{uc.description}</p>
                <p className="text-xs text-muted-foreground/70 italic border-t pt-3">
                  {uc.example}
                </p>
              </div>
            );
          })}
        </section>

        {/* FAQ */}
        <section className="mb-20">
          <h2 className="text-2xl font-bold tracking-tight mb-8 text-center">
            {USE_CASES_LABELS.FAQ_TITLE}
          </h2>
          <div className="rounded-xl border bg-card p-6">
            {FAQS.map((faq) => (
              <FAQItem key={faq.question} question={faq.question} answer={faq.answer} />
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="text-center py-12 px-6 rounded-2xl border bg-card">
          <h2 className="text-2xl font-bold tracking-tight mb-3">
            {USE_CASES_LABELS.CTA_TITLE}
          </h2>
          <p className="text-muted-foreground mb-6 max-w-lg mx-auto">
            {USE_CASES_LABELS.CTA_DESCRIPTION}
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              to={ROUTES.SEARCH}
              className="inline-flex items-center gap-2 rounded-lg border px-6 py-3 text-sm font-medium hover:bg-accent transition-colors"
            >
              {USE_CASES_LABELS.CTA_BUTTON_SEARCH}
            </Link>
            <Link
              to={ROUTES.SIGNUP}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {USE_CASES_LABELS.CTA_BUTTON_SIGNUP}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t mt-16">
        <div className="mx-auto max-w-4xl px-6 py-8">
          <nav className="flex flex-wrap justify-center gap-6 text-sm text-muted-foreground" aria-label="Site navigation">
            <Link to={ROUTES.SEARCH} className="hover:text-primary transition-colors">Search Credentials</Link>
            <Link to={ROUTES.VERIFY_FORM} className="hover:text-primary transition-colors">Verify a Document</Link>
            <Link to={ROUTES.HOW_IT_WORKS} className="hover:text-primary transition-colors">How It Works</Link>
            <Link to={ROUTES.ENTERPRISE} className="hover:text-primary transition-colors">Enterprise</Link>
            <Link to={ROUTES.DEVELOPERS} className="hover:text-primary transition-colors">Developer API</Link>
            <Link to={ROUTES.CONTACT} className="hover:text-primary transition-colors">Contact</Link>
            <Link to={ROUTES.PRIVACY} className="hover:text-primary transition-colors">Privacy</Link>
            <Link to={ROUTES.TERMS} className="hover:text-primary transition-colors">Terms</Link>
          </nav>
          <p className="text-center text-xs text-muted-foreground mt-4">&copy; {new Date().getFullYear()} Arkova</p>
        </div>
      </footer>
    </div>
  );
}
