/**
 * Enterprise Page (GEO-08)
 *
 * Public route at /enterprise. Enterprise features, trust infrastructure,
 * and integration details. Includes Organization JSON-LD schema for SEO.
 */

import { Link } from 'react-router-dom';
import {
  Building2,
  Code2,
  Layers,
  Webhook,
  KeyRound,
  Headphones,
  ShieldCheck,
  Anchor,
  Lock,
  Database,
  Terminal,
  BookOpen,
  Bot,
  Bell,
  ArrowRight,
  CheckCircle2,
} from 'lucide-react';
import { usePageMeta } from '@/hooks/usePageMeta';
import { ENTERPRISE_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';
import { PublicFooter } from '@/components/shared/PublicFooter';

const FEATURES = [
  { icon: Code2, title: ENTERPRISE_LABELS.FEAT_API_TITLE, description: ENTERPRISE_LABELS.FEAT_API_DESC },
  { icon: Layers, title: ENTERPRISE_LABELS.FEAT_BATCH_TITLE, description: ENTERPRISE_LABELS.FEAT_BATCH_DESC },
  { icon: Webhook, title: ENTERPRISE_LABELS.FEAT_WEBHOOKS_TITLE, description: ENTERPRISE_LABELS.FEAT_WEBHOOKS_DESC },
  { icon: KeyRound, title: ENTERPRISE_LABELS.FEAT_SSO_TITLE, description: ENTERPRISE_LABELS.FEAT_SSO_DESC },
  { icon: Headphones, title: ENTERPRISE_LABELS.FEAT_SUPPORT_TITLE, description: ENTERPRISE_LABELS.FEAT_SUPPORT_DESC },
  { icon: ShieldCheck, title: ENTERPRISE_LABELS.FEAT_SLA_TITLE, description: ENTERPRISE_LABELS.FEAT_SLA_DESC },
];

const TRUST_ITEMS = [
  { icon: Anchor, title: ENTERPRISE_LABELS.TRUST_ANCHORING_TITLE, description: ENTERPRISE_LABELS.TRUST_ANCHORING_DESC },
  { icon: CheckCircle2, title: ENTERPRISE_LABELS.TRUST_SOC2_TITLE, description: ENTERPRISE_LABELS.TRUST_SOC2_DESC },
  { icon: Lock, title: ENTERPRISE_LABELS.TRUST_ENCRYPTION_TITLE, description: ENTERPRISE_LABELS.TRUST_ENCRYPTION_DESC },
  { icon: Database, title: ENTERPRISE_LABELS.TRUST_RLS_TITLE, description: ENTERPRISE_LABELS.TRUST_RLS_DESC },
];

const INTEGRATIONS = [
  { icon: Terminal, title: ENTERPRISE_LABELS.INT_API_TITLE, description: ENTERPRISE_LABELS.INT_API_DESC },
  { icon: BookOpen, title: ENTERPRISE_LABELS.INT_SDK_TITLE, description: ENTERPRISE_LABELS.INT_SDK_DESC },
  { icon: Bot, title: ENTERPRISE_LABELS.INT_MCP_TITLE, description: ENTERPRISE_LABELS.INT_MCP_DESC },
  { icon: Bell, title: ENTERPRISE_LABELS.INT_WEBHOOKS_TITLE, description: ENTERPRISE_LABELS.INT_WEBHOOKS_DESC },
];

function OrganizationSchema() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'Arkova',
          url: 'https://arkova.ai',
          description: ENTERPRISE_LABELS.PAGE_DESCRIPTION,
          sameAs: [
            'https://www.linkedin.com/company/arkovatech',
            'https://x.com/arkovatech',
          ],
          contactPoint: {
            '@type': 'ContactPoint',
            contactType: 'sales',
            email: 'hello@arkova.ai',
          },
        }),
      }}
    />
  );
}

export function EnterprisePage() {
  usePageMeta({
    title: ENTERPRISE_LABELS.PAGE_TITLE,
    description: ENTERPRISE_LABELS.PAGE_DESCRIPTION,
  });

  return (
    <div className="min-h-screen bg-background">
      <OrganizationSchema />

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
            {ENTERPRISE_LABELS.HERO_TITLE}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            {ENTERPRISE_LABELS.HERO_SUBTITLE}
          </p>
        </div>

        {/* Features grid */}
        <section className="mb-20">
          <h2 className="text-2xl font-bold tracking-tight mb-8 text-center">
            {ENTERPRISE_LABELS.FEATURES_TITLE}
          </h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map((feat) => {
              const Icon = feat.icon;
              return (
                <div key={feat.title} className="p-6 rounded-xl border bg-card">
                  <Icon className="h-8 w-8 text-primary mb-3" />
                  <h3 className="font-semibold mb-2">{feat.title}</h3>
                  <p className="text-sm text-muted-foreground">{feat.description}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* Trusted Infrastructure */}
        <section className="mb-20">
          <h2 className="text-2xl font-bold tracking-tight mb-8 text-center">
            {ENTERPRISE_LABELS.TRUST_TITLE}
          </h2>
          <div className="grid md:grid-cols-2 gap-6">
            {TRUST_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="flex gap-4 p-6 rounded-xl border bg-card">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1">{item.title}</h3>
                    <p className="text-sm text-muted-foreground">{item.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Integrations */}
        <section className="mb-20">
          <h2 className="text-2xl font-bold tracking-tight mb-2 text-center">
            {ENTERPRISE_LABELS.INTEGRATIONS_TITLE}
          </h2>
          <p className="text-muted-foreground text-center mb-8">
            {ENTERPRISE_LABELS.INTEGRATIONS_SUBTITLE}
          </p>
          <div className="grid md:grid-cols-2 gap-6">
            {INTEGRATIONS.map((int) => {
              const Icon = int.icon;
              return (
                <div key={int.title} className="flex gap-4 p-5 rounded-xl border bg-card">
                  <Icon className="h-6 w-6 text-primary shrink-0 mt-0.5" />
                  <div>
                    <h3 className="font-semibold mb-1">{int.title}</h3>
                    <p className="text-sm text-muted-foreground">{int.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* CTA */}
        <section className="text-center py-12 px-6 rounded-2xl border bg-card">
          <h2 className="text-2xl font-bold tracking-tight mb-3">
            {ENTERPRISE_LABELS.CTA_TITLE}
          </h2>
          <p className="text-muted-foreground mb-6 max-w-lg mx-auto">
            {ENTERPRISE_LABELS.CTA_DESCRIPTION}
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              to={ROUTES.CONTACT}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              {ENTERPRISE_LABELS.CTA_BUTTON_CONTACT}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to={ROUTES.DEVELOPERS}
              className="inline-flex items-center gap-2 rounded-lg border px-6 py-3 text-sm font-medium hover:bg-accent transition-colors"
            >
              {ENTERPRISE_LABELS.CTA_BUTTON_DOCS}
            </Link>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
