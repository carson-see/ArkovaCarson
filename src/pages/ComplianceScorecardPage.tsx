/**
 * Compliance Scorecard Page (NCA-08)
 *
 * Route: /compliance/scorecard
 *
 * Landing page after NCA-07 audit completion. Surfaces the most recent
 * audit's score gauge, per-jurisdiction breakdown, gaps, and NCA-05
 * recommendations — plus the NCA-09 PDF export.
 *
 * Data is fetched from `GET /api/v1/compliance/audit?limit=10` (history)
 * and the most recent row is rendered. The history list drives the
 * score-over-time timeline chart.
 *
 * Jira: SCRUM-763 (NCA-08)
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ShieldCheck,
  FileDown,
  AlertTriangle,
  TrendingUp,
  Clock,
  CheckCircle2,
} from 'lucide-react';
import { AppShell } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ComplianceScoreGauge } from '@/components/compliance/ComplianceScoreGauge';
import { AuditMyOrganizationButton } from '@/components/compliance/AuditMyOrganizationButton';
import { OrgRequiredCard } from '@/components/shared/OrgRequiredCard';
import { AUDIT_MY_ORG_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';
import { downloadAuditPdf } from '@/lib/compliancePdf';
import { useOrganization } from '@/hooks/useOrganization';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/lib/supabase';

interface PerJurisdiction {
  jurisdiction_code: string;
  industry_code: string;
  score: number;
  grade: string;
  total_required: number;
  total_present: number;
  rule_count: number;
}

interface Gap {
  type: string;
  category: 'MISSING' | 'EXPIRED' | 'EXPIRING_SOON' | 'INSUFFICIENT';
  requirement: string;
  jurisdiction_code: string;
  regulatory_reference: string | null;
  severity: 'critical' | 'high' | 'medium' | 'low';
  remediation_hint: string;
  days_remaining?: number;
}

interface Recommendation {
  id: string;
  title: string;
  description: string;
  expected_score_improvement: number;
  effort_hours: number;
  affected_jurisdictions: string[];
  deadline: string | null;
  group: 'QUICK_WIN' | 'CRITICAL' | 'UPCOMING' | 'STANDARD';
  priority_score: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

interface RecommendationResult {
  recommendations: Recommendation[];
  overflow_count: number;
  grouped: {
    quick_wins: Recommendation[];
    critical: Recommendation[];
    upcoming: Recommendation[];
    standard: Recommendation[];
  };
}

interface AuditRow {
  id: string;
  overall_score: number;
  overall_grade: string;
  per_jurisdiction: PerJurisdiction[];
  gaps: Gap[];
  status: string;
  started_at: string;
  completed_at: string | null;
  metadata: { recommendations?: RecommendationResult } & Record<string, unknown>;
}

export interface ComplianceScorecardPageProps {
  /** Injected fetch for tests — defaults to window.fetch. */
  fetchFn?: typeof fetch;
  /** Injected PDF exporter — NCA-09 plugs in client-side PDF generation here. */
  onExportPdf?: (audit: AuditRow) => Promise<void> | void;
}

// Browser fetch wrapper that attaches the Supabase JWT. The worker's
// `requireAuth` middleware rejects any `/api/v1/compliance/*` call that
// doesn't carry a Bearer token — the scorecard shipped in PR #411 without
// this, so the page 401'd for every user until the 2026-04-18 PM fix.
async function fetchWithSupabaseJwt(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  const headers = new Headers(init.headers);
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  return fetch(input, { ...init, credentials: init.credentials ?? 'include', headers });
}

export function ComplianceScorecardPage(props: ComplianceScorecardPageProps = {}) {
  const fetchFn = props.fetchFn ?? (typeof window !== 'undefined' ? fetchWithSupabaseJwt : undefined);
  const { signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { organization } = useOrganization(profile?.org_id);
  const [history, setHistory] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Default NCA-09 PDF export: runs client-side via jsPDF. Tests can inject
  // a custom `onExportPdf` to assert on the handler without generating
  // real binary output.
  const exportPdf = props.onExportPdf ?? ((audit: AuditRow) => {
    const orgName = organization?.display_name ?? 'Organization';
    downloadAuditPdf(audit, { orgName });
  });

  // `/api/v1/compliance/audit` is org-scoped; individuals get 403.
  // Short-circuit the fetch and render the org-required empty state
  // instead of a raw HTTP error banner.
  const isIndividual = !profileLoading && profile !== null && !profile.org_id;

  useEffect(() => {
    if (isIndividual) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      if (!fetchFn) {
        setError(AUDIT_MY_ORG_LABELS.ERROR_FETCH_UNAVAILABLE);
        setLoading(false);
        return;
      }
      try {
        const res = await fetchFn('/api/v1/compliance/audit?limit=10', { credentials: 'include' });
        if (!res.ok) {
          setError(`${AUDIT_MY_ORG_LABELS.ERROR_HTTP_PREFIX} ${res.status}`);
          setLoading(false);
          return;
        }
        const body = (await res.json()) as { audits?: AuditRow[] };
        if (cancelled) return;
        setHistory(body.audits ?? []);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message ?? AUDIT_MY_ORG_LABELS.ERROR_NETWORK);
        setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchFn, isIndividual]);

  const latest = history && history.length > 0 ? history[0] : null;
  const recommendations = latest?.metadata?.recommendations ?? null;

  const handleExport = async () => {
    if (!latest) return;
    setExporting(true);
    try {
      await exportPdf(latest);
    } finally {
      setExporting(false);
    }
  };

  return (
    <AppShell profile={profile} profileLoading={profileLoading} onSignOut={signOut}>
      <main className="mx-auto max-w-6xl space-y-8 px-4 py-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
              {AUDIT_MY_ORG_LABELS.SCORECARD_TITLE}
            </h1>
            {latest?.completed_at && (
              <p className="mt-1 text-sm text-muted-foreground">
                <Clock className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />
                {AUDIT_MY_ORG_LABELS.SCORECARD_LAST_AUDITED}: {formatRelativeTime(latest.completed_at)}
              </p>
            )}
          </div>
          {latest && (
            <Button
              type="button"
              variant="outline"
              onClick={handleExport}
              disabled={exporting}
              data-testid="scorecard-export-pdf"
            >
              <FileDown className="mr-2 h-4 w-4" aria-hidden="true" />
              {exporting ? AUDIT_MY_ORG_LABELS.SCORECARD_EXPORTING : AUDIT_MY_ORG_LABELS.SCORECARD_EXPORT_PDF}
            </Button>
          )}
        </header>

        {loading && <div role="status" aria-live="polite" className="text-sm text-muted-foreground">{AUDIT_MY_ORG_LABELS.SCORECARD_LOADING}</div>}

        {!loading && isIndividual && (
          <OrgRequiredCard
            data-testid="scorecard-org-required"
            title={AUDIT_MY_ORG_LABELS.SCORECARD_ORG_REQUIRED_TITLE}
            description={AUDIT_MY_ORG_LABELS.SCORECARD_ORG_REQUIRED_BODY}
            ctaLabel={AUDIT_MY_ORG_LABELS.SCORECARD_ORG_REQUIRED_CTA}
          />
        )}

        {error && !isIndividual && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm" data-testid="scorecard-error">
            <AlertTriangle className="mr-2 inline h-4 w-4 text-destructive" aria-hidden="true" />
            {error}
          </div>
        )}

        {!loading && !error && !latest && !isIndividual && (
          <Card data-testid="scorecard-empty">
            <CardContent className="space-y-4 py-6">
              <p className="text-sm text-muted-foreground">{AUDIT_MY_ORG_LABELS.SCORECARD_EMPTY}</p>
              <AuditMyOrganizationButton />
            </CardContent>
          </Card>
        )}

        {latest && (
          <>
            <section className="grid grid-cols-1 gap-6 lg:grid-cols-[260px_1fr]">
              <Card className="flex flex-col items-center justify-center p-6" data-testid="scorecard-gauge">
                <ComplianceScoreGauge score={latest.overall_score} grade={latest.overall_grade} size="lg" />
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{AUDIT_MY_ORG_LABELS.SCORECARD_PER_JURISDICTION}</CardTitle>
                </CardHeader>
                <CardContent>
                  <PerJurisdictionBars data={latest.per_jurisdiction} />
                </CardContent>
              </Card>
            </section>

            <Separator />

            <section>
              <h2 className="mb-3 text-lg font-semibold">{AUDIT_MY_ORG_LABELS.SCORECARD_GAPS_HEADING}</h2>
              <GapList gaps={latest.gaps} />
            </section>

            {recommendations && recommendations.recommendations.length > 0 && (
              <>
                <Separator />
                <section>
                  <h2 className="mb-3 text-lg font-semibold">{AUDIT_MY_ORG_LABELS.SCORECARD_RECOMMENDATIONS_HEADING}</h2>
                  <RecommendationSections recommendations={recommendations} />
                </section>
              </>
            )}

            {history && history.length > 1 && (
              <>
                <Separator />
                <section>
                  <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
                    <TrendingUp className="h-4 w-4" aria-hidden="true" />
                    {AUDIT_MY_ORG_LABELS.SCORECARD_TIMELINE}
                  </h2>
                  <ScoreTimeline history={history} />
                </section>
              </>
            )}

            <p className="text-xs text-muted-foreground">{AUDIT_MY_ORG_LABELS.SCORECARD_DISCLAIMER}</p>
          </>
        )}

        <div className="text-sm">
          <Link to={ROUTES.DASHBOARD} className="text-primary hover:underline">
            {AUDIT_MY_ORG_LABELS.SCORECARD_BACK_TO_DASHBOARD}
          </Link>
        </div>
      </main>
    </AppShell>
  );
}

function PerJurisdictionBars({ data }: { readonly data: PerJurisdiction[] }) {
  if (data.length === 0) return <p className="text-sm text-muted-foreground">{AUDIT_MY_ORG_LABELS.SCORECARD_NO_JURISDICTION_DATA}</p>;
  return (
    <ul className="space-y-3">
      {data.map((d) => (
        <li key={`${d.jurisdiction_code}::${d.industry_code}`} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{d.jurisdiction_code} <span className="text-muted-foreground">({d.industry_code})</span></span>
            <span className="tabular-nums">{d.score} / 100 · {d.grade}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full ${barColor(d.score)}`}
              style={{ width: `${Math.max(2, d.score)}%` }}
              aria-label={`${d.jurisdiction_code} score ${d.score}`}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function barColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

function GapList({ gaps }: { readonly gaps: Gap[] }) {
  if (gaps.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
          {AUDIT_MY_ORG_LABELS.SCORECARD_NO_GAPS}
        </CardContent>
      </Card>
    );
  }
  return (
    <ul className="space-y-2" data-testid="scorecard-gaps">
      {gaps.map((g, i) => (
        <li key={`${g.jurisdiction_code}::${g.type}::${g.category}::${i}`} className="rounded-md border border-border/60 bg-card p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant={g.severity === 'critical' ? 'destructive' : 'secondary'} className="uppercase">
              {g.severity}
            </Badge>
            <Badge variant="outline">{g.category}</Badge>
            <span className="font-medium">{g.type}</span>
            <span className="text-muted-foreground">· {g.jurisdiction_code}</span>
          </div>
          <p className="mt-1 text-sm">{g.requirement}</p>
          {g.regulatory_reference && (
            <p className="mt-1 text-xs text-muted-foreground">Ref: {g.regulatory_reference}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{g.remediation_hint}</p>
        </li>
      ))}
    </ul>
  );
}

function RecommendationSections({ recommendations }: { readonly recommendations: RecommendationResult }) {
  const sections: Array<{ key: keyof RecommendationResult['grouped']; label: string }> = [
    { key: 'critical', label: AUDIT_MY_ORG_LABELS.SCORECARD_CRITICAL },
    { key: 'quick_wins', label: AUDIT_MY_ORG_LABELS.SCORECARD_QUICK_WINS },
    { key: 'upcoming', label: AUDIT_MY_ORG_LABELS.SCORECARD_UPCOMING },
    { key: 'standard', label: AUDIT_MY_ORG_LABELS.SCORECARD_STANDARD },
  ];
  return (
    <div className="space-y-6" data-testid="scorecard-recommendations">
      {sections.map(({ key, label }) => {
        const items = recommendations.grouped[key];
        if (items.length === 0) return null;
        return (
          <div key={key}>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{label}</h3>
            <ul className="grid gap-2 md:grid-cols-2">
              {items.map((r) => (
                <li key={r.id} className="rounded-md border border-border/60 bg-card p-3 text-sm">
                  <p className="font-medium">{r.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{r.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1 text-xs">
                    <Badge variant="outline">+{r.expected_score_improvement} pts</Badge>
                    <Badge variant="outline">~{r.effort_hours}h</Badge>
                    {r.affected_jurisdictions.map((j) => (
                      <Badge key={j} variant="secondary">{j}</Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {recommendations.overflow_count > 0 && (
        <p className="text-xs text-muted-foreground">
          {recommendations.overflow_count} more item{recommendations.overflow_count === 1 ? '' : 's'} not shown.
        </p>
      )}
    </div>
  );
}

function ScoreTimeline({ history }: { readonly history: AuditRow[] }) {
  const points = useMemo(() => {
    return [...history]
      .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime())
      .map((h) => ({ x: new Date(h.started_at).getTime(), y: h.overall_score }));
  }, [history]);
  if (points.length < 2) return <p className="text-sm text-muted-foreground">{AUDIT_MY_ORG_LABELS.SCORECARD_TIMELINE_INSUFFICIENT}</p>;

  const WIDTH = 600;
  const HEIGHT = 160;
  const PADDING = 20;
  const xs = points.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const scaleX = (x: number) => PADDING + ((x - minX) / Math.max(1, maxX - minX)) * (WIDTH - PADDING * 2);
  const scaleY = (y: number) => HEIGHT - PADDING - (y / 100) * (HEIGHT - PADDING * 2);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${scaleX(p.x).toFixed(1)},${scaleY(p.y).toFixed(1)}`).join(' ');

  return (
    <svg role="img" aria-label="Score over time" width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="rounded-md border border-border/60">
      <title>Compliance score over time</title>
      <path d={d} fill="none" strokeWidth={2} className="stroke-primary" />
      {points.map((p) => (
        <circle key={p.x} cx={scaleX(p.x)} cy={scaleY(p.y)} r={3} className="fill-primary" />
      ))}
    </svg>
  );
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
