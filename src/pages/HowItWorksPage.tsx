/**
 * How It Works Page (GEO-08)
 *
 * Public route at /how-it-works. Explains the 3-step process:
 * Upload/Fingerprint -> Anchor -> Verify.
 * Includes HowTo JSON-LD schema for SEO.
 */

import { Link } from 'react-router-dom';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Building2, Upload, Anchor, Search, Lock, Sparkles, Globe, ArrowRight } from 'lucide-react';
import { usePageMeta } from '@/hooks/usePageMeta';
import { HOW_IT_WORKS_LABELS, PUBLIC_FOOTER_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';
import { PublicFooter } from '@/components/shared/PublicFooter';
import { YouTubeExplainerEmbed } from '@/components/seo/YouTubeExplainerEmbed';

const STEPS = [
  {
    number: '1',
    icon: Upload,
    title: HOW_IT_WORKS_LABELS.STEP_1_TITLE,
    description: HOW_IT_WORKS_LABELS.STEP_1_DESCRIPTION,
    detail: HOW_IT_WORKS_LABELS.STEP_1_DETAIL,
    color: 'text-blue-500',
    bg: 'bg-blue-500/10',
  },
  {
    number: '2',
    icon: Anchor,
    title: HOW_IT_WORKS_LABELS.STEP_2_TITLE,
    description: HOW_IT_WORKS_LABELS.STEP_2_DESCRIPTION,
    detail: HOW_IT_WORKS_LABELS.STEP_2_DETAIL,
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
  },
  {
    number: '3',
    icon: Search,
    title: HOW_IT_WORKS_LABELS.STEP_3_TITLE,
    description: HOW_IT_WORKS_LABELS.STEP_3_DESCRIPTION,
    detail: HOW_IT_WORKS_LABELS.STEP_3_DETAIL,
    color: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
  },
];

const DIFFERENTIATORS = [
  {
    icon: Lock,
    title: HOW_IT_WORKS_LABELS.DIFF_PRIVACY_TITLE,
    description: HOW_IT_WORKS_LABELS.DIFF_PRIVACY_DESC,
  },
  {
    icon: ArkovaIcon,
    title: HOW_IT_WORKS_LABELS.DIFF_IMMUTABILITY_TITLE,
    description: HOW_IT_WORKS_LABELS.DIFF_IMMUTABILITY_DESC,
  },
  {
    icon: Sparkles,
    title: HOW_IT_WORKS_LABELS.DIFF_AI_TITLE,
    description: HOW_IT_WORKS_LABELS.DIFF_AI_DESC,
  },
  {
    icon: Globe,
    title: HOW_IT_WORKS_LABELS.DIFF_OPEN_TITLE,
    description: HOW_IT_WORKS_LABELS.DIFF_OPEN_DESC,
  },
];

function HowToSchema() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'HowTo',
          name: 'How to Verify a Credential with Arkova',
          description: HOW_IT_WORKS_LABELS.HERO_SUBTITLE,
          step: [
            {
              '@type': 'HowToStep',
              position: 1,
              name: HOW_IT_WORKS_LABELS.STEP_1_TITLE,
              text: HOW_IT_WORKS_LABELS.STEP_1_DESCRIPTION,
            },
            {
              '@type': 'HowToStep',
              position: 2,
              name: HOW_IT_WORKS_LABELS.STEP_2_TITLE,
              text: HOW_IT_WORKS_LABELS.STEP_2_DESCRIPTION,
            },
            {
              '@type': 'HowToStep',
              position: 3,
              name: HOW_IT_WORKS_LABELS.STEP_3_TITLE,
              text: HOW_IT_WORKS_LABELS.STEP_3_DESCRIPTION,
            },
          ],
        }),
      }}
    />
  );
}

export function HowItWorksPage() {
  usePageMeta({
    title: HOW_IT_WORKS_LABELS.PAGE_TITLE,
    description: HOW_IT_WORKS_LABELS.PAGE_DESCRIPTION,
  });

  return (
    <div className="min-h-screen bg-background">
      <HowToSchema />

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
            {HOW_IT_WORKS_LABELS.HERO_TITLE}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {HOW_IT_WORKS_LABELS.HERO_SUBTITLE}
          </p>
        </div>

        {/* Explainer video slot — renders only when a matching entry exists in VIDEOS.
            See docs/marketing/video-publishing-checklist.md for the add-a-video workflow. */}
        <YouTubeExplainerEmbed embedPage="https://arkova.ai/how-it-works" />

        {/* Steps */}
        <section className="mb-20" aria-label="How it works steps">
          <div className="space-y-12">
            {STEPS.map((step) => {
              const Icon = step.icon;
              return (
                <div key={step.number} className="flex gap-6 items-start">
                  <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${step.bg}`}>
                    <Icon className={`h-6 w-6 ${step.color}`} />
                  </div>
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className={`text-sm font-bold ${step.color}`}>
                        {`${PUBLIC_FOOTER_LABELS.STEP_PREFIX} ${step.number}`}
                      </span>
                    </div>
                    <h2 className="text-xl font-semibold mb-2">{step.title}</h2>
                    <p className="text-muted-foreground mb-2">{step.description}</p>
                    <p className="text-sm text-muted-foreground/80 italic">{step.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Differentiators */}
        <section className="mb-20">
          <h2 className="text-2xl font-bold tracking-tight mb-8 text-center">
            {HOW_IT_WORKS_LABELS.DIFFERENTIATORS_TITLE}
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            {DIFFERENTIATORS.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="p-6 rounded-xl border bg-card">
                  <Icon className="h-8 w-8 text-primary mb-3" />
                  <h3 className="font-semibold mb-2">{item.title}</h3>
                  <p className="text-sm text-muted-foreground">{item.description}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* CTA */}
        <section className="text-center py-12 px-6 rounded-2xl border bg-card">
          <h2 className="text-2xl font-bold tracking-tight mb-3">
            {HOW_IT_WORKS_LABELS.CTA_TITLE}
          </h2>
          <p className="text-muted-foreground mb-6 max-w-lg mx-auto">
            {HOW_IT_WORKS_LABELS.CTA_DESCRIPTION}
          </p>
          <Link
            to={ROUTES.SIGNUP}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            {HOW_IT_WORKS_LABELS.CTA_BUTTON}
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
