/**
 * Independent Verification Guide (COMP-03)
 *
 * Public page at /verify/independent showing step-by-step instructions
 * to verify Arkova credentials without using Arkova's API.
 * Proves vendor independence — a critical trust differentiator.
 */

import { Link } from 'react-router-dom';
import { Building2, Terminal, Download, ArrowRight, HelpCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { usePageMeta } from '@/hooks/usePageMeta';
import { INDEPENDENT_VERIFY_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

const STEPS = [
  { title: INDEPENDENT_VERIFY_LABELS.STEP_1_TITLE, desc: INDEPENDENT_VERIFY_LABELS.STEP_1_DESC, cmd: INDEPENDENT_VERIFY_LABELS.STEP_1_CMD },
  { title: INDEPENDENT_VERIFY_LABELS.STEP_2_TITLE, desc: INDEPENDENT_VERIFY_LABELS.STEP_2_DESC, cmd: INDEPENDENT_VERIFY_LABELS.STEP_2_CMD },
  { title: INDEPENDENT_VERIFY_LABELS.STEP_3_TITLE, desc: INDEPENDENT_VERIFY_LABELS.STEP_3_DESC, cmd: INDEPENDENT_VERIFY_LABELS.STEP_3_CMD },
  { title: INDEPENDENT_VERIFY_LABELS.STEP_4_TITLE, desc: INDEPENDENT_VERIFY_LABELS.STEP_4_DESC, cmd: INDEPENDENT_VERIFY_LABELS.STEP_4_CMD },
];

const FAQS = [
  { q: INDEPENDENT_VERIFY_LABELS.FAQ_SHUTDOWN_Q, a: INDEPENDENT_VERIFY_LABELS.FAQ_SHUTDOWN_A },
  { q: INDEPENDENT_VERIFY_LABELS.FAQ_OFFLINE_Q, a: INDEPENDENT_VERIFY_LABELS.FAQ_OFFLINE_A },
  { q: INDEPENDENT_VERIFY_LABELS.FAQ_TRUST_Q, a: INDEPENDENT_VERIFY_LABELS.FAQ_TRUST_A },
];

export function IndependentVerifyPage() {
  usePageMeta({
    title: INDEPENDENT_VERIFY_LABELS.PAGE_TITLE + ' — Arkova',
    description: INDEPENDENT_VERIFY_LABELS.PAGE_DESCRIPTION,
  });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity">
            <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-primary/10">
              <Building2 className="h-4 w-4 text-primary" />
            </div>
            <span className="font-semibold">Arkova</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-12 text-center">
          <h1 className="text-4xl font-bold tracking-tight mb-4">{INDEPENDENT_VERIFY_LABELS.HERO_TITLE}</h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">{INDEPENDENT_VERIFY_LABELS.HERO_SUBTITLE}</p>
        </div>

        {/* Steps */}
        <section className="mb-16 space-y-8">
          {STEPS.map((step, i) => (
            <Card key={step.title} className="overflow-hidden">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-primary/10 text-primary font-bold text-sm">
                    {i + 1}
                  </div>
                  <CardTitle className="text-lg">{step.title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground mb-3">{step.desc}</p>
                <div className="bg-[#1a1a2e] rounded-sm p-3 font-mono text-sm text-emerald-400 flex items-center gap-2 overflow-x-auto">
                  <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <code>{step.cmd}</code>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        {/* Download script */}
        <section className="mb-16 text-center">
          <Button variant="outline" size="lg" asChild>
            <a href="/verify.sh" download>
              <Download className="h-4 w-4 mr-2" />
              {INDEPENDENT_VERIFY_LABELS.DOWNLOAD_SCRIPT}
            </a>
          </Button>
          <p className="text-xs text-muted-foreground mt-2">Requires: bash, curl, shasum, jq</p>
        </section>

        {/* FAQ */}
        <section className="mb-16">
          <h2 className="text-2xl font-bold tracking-tight mb-6 text-center flex items-center justify-center gap-2">
            <HelpCircle className="h-5 w-5" /> Frequently Asked Questions
          </h2>
          <div className="space-y-4">
            {FAQS.map(faq => (
              <Card key={faq.q}>
                <CardContent className="pt-6">
                  <h3 className="font-semibold mb-2">{faq.q}</h3>
                  <p className="text-sm text-muted-foreground">{faq.a}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="text-center py-8 border-t">
          <p className="text-muted-foreground mb-4">Want the easy way?</p>
          <Link to={ROUTES.VERIFY_FORM} className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-6 py-3 rounded-sm font-medium hover:bg-primary/90">
            Verify on Arkova <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </main>

      {/* HowTo JSON-LD */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'HowTo',
        name: 'How to Verify an Arkova Credential Without Arkova',
        description: INDEPENDENT_VERIFY_LABELS.PAGE_DESCRIPTION,
        step: STEPS.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.title, text: s.desc })),
      }) }} />
    </div>
  );
}
