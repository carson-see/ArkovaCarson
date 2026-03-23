/**
 * State Bar CLE API Page
 *
 * Public-facing documentation page for state bar associations.
 * Explains how to use the CLE Verification API to check attorney compliance.
 * No authentication required.
 */

import { Link } from 'react-router-dom';
import {
  Scale,
  CheckCircle,
  Search,
  FileText,
  Shield,
  ArrowRight,
  Building2,
  Clock,
  BarChart3,
} from 'lucide-react';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { Badge } from '@/components/ui/badge';
import { ROUTES } from '@/lib/routes';
import { WORKER_URL } from '@/lib/workerClient';

const API_BASE = WORKER_URL;

export function StateBarApiPage() {
  return (
    <div className="min-h-screen bg-[#0d141b] text-[#dce3ed]">
      {/* Header */}
      <header className="border-b border-[#bbc9cf]/15">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to={ROUTES.SEARCH} className="flex items-center gap-3">
            <ArkovaLogo size={32} />
            <span className="text-lg font-semibold">Arkova</span>
          </Link>
          <div className="flex items-center gap-4">
            <Link to={ROUTES.DEVELOPERS} className="text-sm text-[#bbc9cf] hover:text-[#dce3ed]">
              Developers
            </Link>
            <Link
              to={ROUTES.SIGNUP}
              className="px-4 py-2 text-sm font-medium bg-[#00d4ff] text-[#0d141b] rounded-lg hover:bg-[#00d4ff]/90"
            >
              Get Started
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="px-6 py-20 text-center">
          <div className="max-w-3xl mx-auto">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#00d4ff]/30 bg-[#00d4ff]/10 text-[#00d4ff] text-xs font-medium mb-6">
              <Scale className="h-3 w-3" />
              CLE Verification API
            </div>
            <h1 className="text-4xl md:text-5xl font-black tracking-tighter mb-4">
              Verify Attorney CLE Compliance
              <br />
              <span className="text-[#00d4ff]">In Seconds</span>
            </h1>
            <p className="text-lg text-[#bbc9cf] max-w-xl mx-auto">
              Instant, API-driven verification of Continuing Legal Education credits.
              Every credit is anchored to an immutable network — tamper-proof and independently verifiable.
            </p>
          </div>
        </section>

        {/* How it works */}
        <section className="px-6 py-16 bg-[#151c24]">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-2xl font-black mb-12 flex items-center gap-3">
              <span className="w-1.5 h-6 bg-[#00d4ff]" />
              How It Works
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#00d4ff]/10">
                    <Building2 className="h-5 w-5 text-[#00d4ff]" />
                  </div>
                  <span className="text-xs font-mono text-[#859398]">STEP 1</span>
                </div>
                <h3 className="text-lg font-bold">Providers Submit Credits</h3>
                <p className="text-sm text-[#bbc9cf]">
                  CLE providers submit course completions via API or CSV bulk upload. Each credit
                  includes bar number, credit hours, category, jurisdiction, and completion date.
                </p>
              </div>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#00d4ff]/10">
                    <Shield className="h-5 w-5 text-[#00d4ff]" />
                  </div>
                  <span className="text-xs font-mono text-[#859398]">STEP 2</span>
                </div>
                <h3 className="text-lg font-bold">Credits Are Anchored</h3>
                <p className="text-sm text-[#bbc9cf]">
                  Each credit is cryptographically fingerprinted and anchored to an immutable network.
                  The record cannot be altered, backdated, or fabricated after submission.
                </p>
              </div>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#00d4ff]/10">
                    <CheckCircle className="h-5 w-5 text-[#00d4ff]" />
                  </div>
                  <span className="text-xs font-mono text-[#859398]">STEP 3</span>
                </div>
                <h3 className="text-lg font-bold">Bars Verify Compliance</h3>
                <p className="text-sm text-[#bbc9cf]">
                  State bars query the API with a bar number to get instant compliance status —
                  total hours, ethics hours, category breakdown, and per-credit anchor proofs.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* API Endpoints */}
        <section className="px-6 py-16">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-2xl font-black mb-12 flex items-center gap-3">
              <span className="w-1.5 h-6 bg-[#00d4ff]" />
              API Endpoints
            </h2>
            <div className="space-y-6">
              {/* Verify */}
              <div className="bg-[#192028] rounded-lg border border-[#3c494e]/15 overflow-hidden">
                <div className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <Badge variant="outline" className="text-emerald-400 border-emerald-400/30 bg-emerald-400/10">GET</Badge>
                    <code className="text-sm font-mono text-[#dce3ed]">/api/v1/cle/verify</code>
                    <span className="text-xs text-[#859398] ml-auto">$0.005/req</span>
                  </div>
                  <p className="text-sm text-[#bbc9cf] mb-4">
                    Verify an attorney's CLE compliance against jurisdiction requirements.
                  </p>
                  <div className="bg-[#0d141b] rounded-lg p-4 font-mono text-xs overflow-x-auto">
                    <div className="text-[#859398]"># Check compliance for bar number 12345 in California</div>
                    <div>
                      <span className="text-[#a8e8ff]">curl</span> <span className="text-[#bbc9cf]">"{API_BASE}/api/v1/cle/verify?bar_number=12345&jurisdiction=California"</span>
                    </div>
                  </div>
                  <div className="mt-4 text-xs text-[#bbc9cf]">
                    <strong className="text-[#dce3ed]">Response includes:</strong> compliance_status (compliant/deficient), total hours, ethics hours, credits by category, anchored records with proof
                  </div>
                </div>
              </div>

              {/* Credits */}
              <div className="bg-[#192028] rounded-lg border border-[#3c494e]/15 overflow-hidden">
                <div className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <Badge variant="outline" className="text-emerald-400 border-emerald-400/30 bg-emerald-400/10">GET</Badge>
                    <code className="text-sm font-mono text-[#dce3ed]">/api/v1/cle/credits</code>
                    <span className="text-xs text-[#859398] ml-auto">$0.005/req</span>
                  </div>
                  <p className="text-sm text-[#bbc9cf] mb-4">
                    List all anchored CLE credits for an attorney, filterable by jurisdiction and period.
                  </p>
                  <div className="bg-[#0d141b] rounded-lg p-4 font-mono text-xs overflow-x-auto">
                    <div className="text-[#859398]"># List credits with period filter</div>
                    <div>
                      <span className="text-[#a8e8ff]">curl</span> <span className="text-[#bbc9cf]">"{API_BASE}/api/v1/cle/credits?bar_number=12345&period_start=2025-01-01"</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Submit */}
              <div className="bg-[#192028] rounded-lg border border-[#3c494e]/15 overflow-hidden">
                <div className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <Badge variant="outline" className="text-[#a8e8ff] border-[#a8e8ff]/30 bg-[#a8e8ff]/10">POST</Badge>
                    <code className="text-sm font-mono text-[#dce3ed]">/api/v1/cle/submit</code>
                    <span className="text-xs text-[#859398] ml-auto">$0.005/req</span>
                  </div>
                  <p className="text-sm text-[#bbc9cf] mb-4">
                    Submit a CLE course completion for anchoring. For CLE providers only (authentication required).
                  </p>
                  <div className="bg-[#0d141b] rounded-lg p-4 font-mono text-xs overflow-x-auto">
                    <div className="text-[#859398]"># Submit a CLE completion</div>
                    <div><span className="text-[#a8e8ff]">curl</span> -X POST {API_BASE}/api/v1/cle/submit \</div>
                    <div>  -H <span className="text-[#bbc9cf]">"Authorization: Bearer YOUR_API_KEY"</span> \</div>
                    <div>  -H <span className="text-[#bbc9cf]">"Content-Type: application/json"</span> \</div>
                    <div>  -d <span className="text-[#5fd6eb]">{'\'{"bar_number":"12345","course_title":"Ethics in AI","provider_name":"National Legal Academy","credit_hours":3,"credit_category":"Ethics","jurisdiction":"California","completion_date":"2026-03-15"}\''}</span></div>
                  </div>
                </div>
              </div>

              {/* Requirements */}
              <div className="bg-[#192028] rounded-lg border border-[#3c494e]/15 overflow-hidden">
                <div className="p-6">
                  <div className="flex items-center gap-3 mb-3">
                    <Badge variant="outline" className="text-emerald-400 border-emerald-400/30 bg-emerald-400/10">GET</Badge>
                    <code className="text-sm font-mono text-[#dce3ed]">/api/v1/cle/requirements</code>
                    <span className="text-xs text-[#859398] ml-auto">Free</span>
                  </div>
                  <p className="text-sm text-[#bbc9cf]">
                    Reference endpoint returning CLE requirements for 15 jurisdictions. Includes total hours, ethics hours, and reporting period length.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Benefits */}
        <section className="px-6 py-16 bg-[#151c24]">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-2xl font-black mb-12 flex items-center gap-3">
              <span className="w-1.5 h-6 bg-[#00d4ff]" />
              Why Arkova for CLE
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="flex gap-4">
                <Clock className="h-6 w-6 text-[#00d4ff] shrink-0 mt-1" />
                <div>
                  <h3 className="font-bold mb-1">Instant Verification</h3>
                  <p className="text-sm text-[#bbc9cf]">API response in under 200ms. No manual review, no phone calls, no waiting for transcripts.</p>
                </div>
              </div>
              <div className="flex gap-4">
                <Shield className="h-6 w-6 text-[#00d4ff] shrink-0 mt-1" />
                <div>
                  <h3 className="font-bold mb-1">Tamper-Proof Records</h3>
                  <p className="text-sm text-[#bbc9cf]">Every credit is anchored to an immutable network. Cannot be altered, backdated, or fabricated after submission.</p>
                </div>
              </div>
              <div className="flex gap-4">
                <BarChart3 className="h-6 w-6 text-[#00d4ff] shrink-0 mt-1" />
                <div>
                  <h3 className="font-bold mb-1">Auto Compliance Checking</h3>
                  <p className="text-sm text-[#bbc9cf]">API automatically checks credit totals against jurisdiction requirements (15 states supported) and returns compliant/deficient status.</p>
                </div>
              </div>
              <div className="flex gap-4">
                <Search className="h-6 w-6 text-[#00d4ff] shrink-0 mt-1" />
                <div>
                  <h3 className="font-bold mb-1">Cross-Provider Aggregation</h3>
                  <p className="text-sm text-[#bbc9cf]">Credits from all providers are aggregated in one place. Bar can see complete picture regardless of which provider the attorney used.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 py-20 text-center">
          <div className="max-w-xl mx-auto">
            <h2 className="text-3xl font-black mb-4">Ready to modernize CLE verification?</h2>
            <p className="text-[#bbc9cf] mb-8">
              Contact us to discuss integration for your state bar or CLE provider organization.
            </p>
            <div className="flex gap-4 justify-center">
              <Link
                to={ROUTES.CONTACT}
                className="px-6 py-3 bg-[#00d4ff] text-[#0d141b] rounded-lg font-medium hover:bg-[#00d4ff]/90 flex items-center gap-2"
              >
                Contact Us <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to={ROUTES.DEVELOPERS}
                className="px-6 py-3 border border-[#bbc9cf]/30 rounded-lg font-medium hover:bg-[#192028] flex items-center gap-2"
              >
                <FileText className="h-4 w-4" /> Full API Docs
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#bbc9cf]/15">
        <div className="max-w-7xl mx-auto py-8 px-6 flex justify-between items-center">
          <div className="flex items-center gap-2">
            <ArkovaLogo size={20} />
            <span className="text-sm text-[#bbc9cf]">Secure document verification platform.</span>
          </div>
          <div className="flex gap-6 text-sm text-[#bbc9cf]">
            <Link to={ROUTES.PRIVACY} className="hover:text-[#dce3ed]">Privacy</Link>
            <Link to={ROUTES.TERMS} className="hover:text-[#dce3ed]">Terms</Link>
            <Link to={ROUTES.CONTACT} className="hover:text-[#dce3ed]">Contact</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
