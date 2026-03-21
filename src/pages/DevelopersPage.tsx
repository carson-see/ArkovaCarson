/**
 * Developers Page
 *
 * Public-facing page for API documentation and developer resources.
 * Showcases the Verification API, AI Intelligence endpoints, and MCP server.
 * No authentication required.
 */

import { Link } from 'react-router-dom';
import {
  Shield,
  Code2,
  ExternalLink,
  FileJson,
  BookOpen,
  Bot,
  CheckCircle2,
  Layers,
  Sparkles,
  Search,
  ArrowRight,
  Terminal,
  Copy,
} from 'lucide-react';
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ROUTES } from '@/lib/routes';
import { DEVELOPER_PAGE_LABELS as L } from '@/lib/copy';
import { WORKER_URL } from '@/lib/workerClient';

const API_DOCS_URL = `${WORKER_URL}/api/docs`;
const OPENAPI_SPEC_URL = `${WORKER_URL}/api/docs/spec.json`;

const CURL_EXAMPLE = `curl -H "Authorization: Bearer YOUR_API_KEY" \\
  ${WORKER_URL}/api/v1/verify/abc123-def456`;

export function DevelopersPage() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(CURL_EXAMPLE);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen flex flex-col bg-mesh-gradient">
      {/* Header */}
      <header className="border-b glass-header">
        <div className="container flex h-16 items-center justify-between">
          <Link to={ROUTES.SEARCH} className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary">
              <Shield className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="text-lg font-semibold">Arkova</span>
          </Link>
          <nav className="flex items-center gap-4">
            <Link
              to={ROUTES.SEARCH}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Search
            </Link>
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
      <main className="flex-1">
        {/* Hero */}
        <section className="container py-16 md:py-24 text-center">
          <div className="flex justify-center mb-6">
            <Badge variant="secondary" className="gap-1.5 px-3 py-1 text-xs">
              <Code2 className="h-3.5 w-3.5" />
              Verification API
            </Badge>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
            {L.HERO_TITLE}
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto mb-8">
            {L.HERO_SUBTITLE}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Button size="lg" asChild>
              <a href={API_DOCS_URL} target="_blank" rel="noopener noreferrer">
                <BookOpen className="mr-2 h-4 w-4" />
                {L.LINK_API_DOCS}
              </a>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link to={ROUTES.SIGNUP}>
                Get Started
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </section>

        {/* API Overview Cards */}
        <section className="container pb-16">
          <div className="grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
            <Card className="glass-card shadow-card-rest">
              <CardHeader>
                <div className="flex items-center gap-2 mb-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  <Badge variant="outline" className="font-mono text-xs">{L.CARD_VERIFY_ENDPOINT}</Badge>
                </div>
                <CardTitle className="text-lg">{L.CARD_VERIFY_TITLE}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{L.CARD_VERIFY_DESC}</p>
              </CardContent>
            </Card>

            <Card className="glass-card shadow-card-rest">
              <CardHeader>
                <div className="flex items-center gap-2 mb-2">
                  <Layers className="h-5 w-5 text-blue-500" />
                  <Badge variant="outline" className="font-mono text-xs">{L.CARD_BATCH_ENDPOINT}</Badge>
                </div>
                <CardTitle className="text-lg">{L.CARD_BATCH_TITLE}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{L.CARD_BATCH_DESC}</p>
              </CardContent>
            </Card>

            <Card className="glass-card shadow-card-rest">
              <CardHeader>
                <div className="flex items-center gap-2 mb-2">
                  <Sparkles className="h-5 w-5 text-amber-500" />
                  <Badge variant="outline" className="font-mono text-xs">{L.CARD_AI_ENDPOINT}</Badge>
                </div>
                <CardTitle className="text-lg">{L.CARD_AI_TITLE}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{L.CARD_AI_DESC}</p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Getting Started */}
        <section className="container pb-16">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-2xl font-bold tracking-tight mb-8 text-center">
              {L.GETTING_STARTED_TITLE}
            </h2>

            <div className="space-y-4 mb-8">
              {[L.STEP_1, L.STEP_2, L.STEP_3].map((step, i) => (
                <div key={step} className="flex items-start gap-4">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
                    {i + 1}
                  </div>
                  <p className="text-sm text-muted-foreground pt-1.5">{step}</p>
                </div>
              ))}
            </div>

            {/* Curl example */}
            <Card className="glass-card shadow-card-rest overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Terminal className="h-3.5 w-3.5" />
                  <span>{L.CURL_COMMENT}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={handleCopy}
                >
                  <Copy className="h-3 w-3 mr-1" />
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <pre className="p-4 text-sm font-mono text-foreground overflow-x-auto">
                <code>{CURL_EXAMPLE}</code>
              </pre>
            </Card>
          </div>
        </section>

        {/* Resources */}
        <section className="container pb-16">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-2xl font-bold tracking-tight mb-8 text-center">
              {L.LINKS_TITLE}
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <ResourceLink
                href={API_DOCS_URL}
                icon={BookOpen}
                title={L.LINK_API_DOCS}
                desc={L.LINK_API_DOCS_DESC}
                external
              />
              <ResourceLink
                href={OPENAPI_SPEC_URL}
                icon={FileJson}
                title={L.LINK_OPENAPI_SPEC}
                desc={L.LINK_OPENAPI_SPEC_DESC}
                external
              />
              <ResourceLink
                href="/AGENTS.md"
                icon={Bot}
                title={L.LINK_AGENT_GUIDE}
                desc={L.LINK_AGENT_GUIDE_DESC}
                external
              />
              <ResourceLink
                href="/llms.txt"
                icon={Search}
                title={L.LINK_LLM_DISCOVERY}
                desc={L.LINK_LLM_DISCOVERY_DESC}
                external
              />
            </div>
          </div>
        </section>

        {/* MCP Server */}
        <section className="container pb-16">
          <div className="max-w-3xl mx-auto">
            <Card className="glass-card shadow-card-rest">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-primary" />
                  <CardTitle>{L.MCP_TITLE}</CardTitle>
                </div>
                <CardDescription>{L.MCP_DESC}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <code className="rounded bg-muted px-2 py-0.5 font-mono text-sm text-primary">
                      {L.MCP_TOOL_VERIFY}
                    </code>
                    <span className="text-sm text-muted-foreground">{L.MCP_TOOL_VERIFY_DESC}</span>
                  </div>
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <code className="rounded bg-muted px-2 py-0.5 font-mono text-sm text-primary">
                      {L.MCP_TOOL_SEARCH}
                    </code>
                    <span className="text-sm text-muted-foreground">{L.MCP_TOOL_SEARCH_DESC}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
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

function ResourceLink({
  href,
  icon: Icon,
  title,
  desc,
  external,
}: Readonly<{
  href: string;
  icon: React.ElementType;
  title: string;
  desc: string;
  external?: boolean;
}>) {
  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      className="group flex items-start gap-3 rounded-lg border bg-card/70 p-4 transition-colors hover:bg-accent glass-card"
    >
      <Icon className="h-5 w-5 shrink-0 text-primary mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium group-hover:text-primary transition-colors">{title}</span>
          {external && <ExternalLink className="h-3 w-3 text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </div>
    </a>
  );
}
