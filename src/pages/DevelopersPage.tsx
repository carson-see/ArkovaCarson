/**
 * Developers Page — Synthetic Sentinel Design
 *
 * Public-facing developer platform page built from Stitch wireframe.
 * Showcases the Verification API, AI Intelligence endpoints, and MCP server.
 * No authentication required.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Layers, Brain, ArrowRight, Copy, Check, Bot, AlertCircle, Building2, Key, Gauge } from 'lucide-react';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { ROUTES } from '@/lib/routes';
import { WORKER_URL } from '@/lib/workerClient';

const API_DOCS_URL = `${WORKER_URL}/api/docs`;
const OPENAPI_SPEC_URL = `${WORKER_URL}/api/docs/spec.json`;

const CURL_LINES = [
  { num: '1', parts: [{ text: 'curl', cls: 'text-[#a8e8ff]' }, { text: ' -X POST', cls: 'text-[#dce3ed]' }] },
  { num: '2', parts: [{ text: `  ${WORKER_URL}/api/v1/verify`, cls: 'text-[#bbc9cf]' }] },
  { num: '3', parts: [{ text: '  -H "Authorization: Bearer ', cls: 'text-[#bbc9cf]' }, { text: 'YOUR_API_KEY', cls: 'text-[#00d4ff]' }, { text: '"', cls: 'text-[#bbc9cf]' }] },
  { num: '4', parts: [{ text: '  -H "Content-Type: application/json"', cls: 'text-[#bbc9cf]' }] },
  { num: '5', parts: [{ text: "  -d '{", cls: 'text-[#bbc9cf]' }] },
  { num: '6', parts: [{ text: '    ', cls: '' }, { text: '"public_id"', cls: 'text-[#5fd6eb]' }, { text: ': ', cls: 'text-[#bbc9cf]' }, { text: '"abc123-def456"', cls: 'text-[#00d4ff]' }, { text: ',', cls: 'text-[#bbc9cf]' }] },
  { num: '7', parts: [{ text: '    ', cls: '' }, { text: '"ai_metadata"', cls: 'text-[#5fd6eb]' }, { text: ': ', cls: 'text-[#bbc9cf]' }, { text: 'true', cls: 'text-[#00d4ff]' }] },
  { num: '8', parts: [{ text: "  }'", cls: 'text-[#bbc9cf]' }] },
];

const CURL_RAW = `curl -X POST \\
  ${WORKER_URL}/api/v1/verify \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "public_id": "abc123-def456",
    "ai_metadata": true
  }'`;

export function DevelopersPage() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(CURL_RAW);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#0d141b] text-[#dce3ed] selection:bg-[#00d4ff] selection:text-[#003642]">
      {/* Fixed Header */}
      <header className="fixed top-0 z-50 w-full bg-[#0d141b] px-6 py-4 flex justify-between items-center">
        <Link to={ROUTES.SEARCH} className="flex items-center gap-2">
          <ArkovaLogo size={32} />
          <span className="text-xl font-black text-[#00d4ff] tracking-tighter">Arkova</span>
        </Link>
        <nav className="hidden md:flex items-center gap-8">
          <span className="text-[#00d4ff] border-b-2 border-[#00d4ff] pb-1 font-bold tracking-tight text-sm">
            Docs
          </span>
          <a
            href={API_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#bbc9cf] font-bold tracking-tight text-sm hover:text-[#a8e8ff] transition-colors"
          >
            API Reference
          </a>
          <Link
            to={ROUTES.HELP}
            className="text-[#bbc9cf] font-bold tracking-tight text-sm hover:text-[#a8e8ff] transition-colors"
          >
            Support
          </Link>
        </nav>
        <div className="flex items-center gap-4">
          <Link
            to={ROUTES.LOGIN}
            className="text-xs uppercase tracking-wider text-[#bbc9cf] hover:text-[#00d4ff] transition-all font-semibold"
          >
            Sign In
          </Link>
          <Link
            to={ROUTES.SIGNUP}
            className="bg-[#00d4ff] text-[#003642] text-xs uppercase tracking-widest px-6 py-2.5 rounded-full font-bold shadow-[0_0_15px_rgba(0,212,255,0.3)] hover:shadow-[0_0_25px_rgba(0,212,255,0.5)] transition-all"
          >
            Get Started
          </Link>
        </div>
      </header>

      <main className="pt-24 pb-20">
        {/* Hero */}
        <section className="relative px-6 py-20 md:py-32 overflow-hidden">
          <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-[#00d4ff]/10 rounded-full blur-[120px] -z-10 translate-x-1/2 -translate-y-1/2" />
          <div className="max-w-7xl mx-auto flex flex-col items-center text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#242b32] border border-[#3c494e]/20 mb-8">
              <span className="w-2 h-2 rounded-full bg-[#00d4ff] animate-pulse" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-[#a8e8ff] font-semibold">
                Verification API Active
              </span>
            </div>
            <h1 className="text-5xl md:text-8xl font-black tracking-tighter mb-6 leading-[0.9]">
              Developer{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-br from-[#a8e8ff] to-[#00d4ff]">
                Platform
              </span>
            </h1>
            <p className="max-w-2xl text-[#bbc9cf] text-lg md:text-xl leading-relaxed mb-10">
              Engineered for high-trust environments. Implement programmatic verification and AI-powered metadata extraction with cryptographic certainty.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to={ROUTES.SIGNUP}
                className="px-8 py-4 bg-[#00d4ff] text-[#003642] rounded-full font-bold uppercase tracking-widest text-sm hover:shadow-[0_0_30px_rgba(0,212,255,0.4)] transition-all"
              >
                Get Started
              </Link>
              <a
                href={API_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="px-8 py-4 bg-[#333a42]/10 border border-[#3c494e]/20 text-[#dce3ed] rounded-full font-bold uppercase tracking-widest text-sm hover:bg-[#333a42]/20 transition-all"
              >
                API Documentation
              </a>
            </div>
          </div>
        </section>

        {/* Feature Grid */}
        <section className="px-6 py-20 max-w-7xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="bg-[#192028] p-8 rounded-lg group hover:bg-[#242b32] transition-colors">
              <div className="text-[#a8e8ff] mb-6">
                <ShieldCheck className="h-10 w-10" strokeWidth={1.5} />
              </div>
              <h3 className="text-xl font-bold mb-4">Verify Credentials</h3>
              <p className="text-[#bbc9cf] text-sm leading-relaxed">
                Instant, high-fidelity verification of credentials against permanent cryptographic records. One API call returns full proof details.
              </p>
            </div>
            <div className="bg-[#192028] p-8 rounded-lg group hover:bg-[#242b32] transition-colors">
              <div className="text-[#a8e8ff] mb-6">
                <Layers className="h-10 w-10" strokeWidth={1.5} />
              </div>
              <h3 className="text-xl font-bold mb-4">Batch Verification</h3>
              <p className="text-[#bbc9cf] text-sm leading-relaxed">
                Scalable architecture for high-throughput environments. Verify up to 100 credentials per request with async job polling.
              </p>
            </div>
            <div className="bg-[#192028] p-8 rounded-lg group hover:bg-[#242b32] transition-colors">
              <div className="text-[#a8e8ff] mb-6">
                <Brain className="h-10 w-10" strokeWidth={1.5} />
              </div>
              <h3 className="text-xl font-bold mb-4">AI Intelligence</h3>
              <p className="text-[#bbc9cf] text-sm leading-relaxed">
                Context-aware metadata extraction that transforms documents into structured credential data. Semantic search and integrity scoring.
              </p>
            </div>
          </div>
        </section>

        {/* Getting Started + Code */}
        <section className="px-6 py-20 bg-[#151c24]">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-3xl md:text-4xl font-black tracking-tight mb-12">Fast Integration</h2>
              <div className="space-y-12">
                {[
                  { step: '1', title: 'Create an Organization Account', desc: 'Sign up and select the Organization role during onboarding. API keys require an Organization account — Individual accounts cannot create API keys.' },
                  { step: '2', title: 'Generate API Keys', desc: 'Navigate to Settings → API Keys in the dashboard. Keys use Bearer token authentication with HMAC-SHA256 security.' },
                  { step: '3', title: 'Execute Verification', desc: 'Send your first verification request and receive real-time cryptographic proof.' },
                ].map((s) => (
                  <div key={s.step} className="flex gap-6">
                    <div className="flex-none w-10 h-10 rounded-full bg-[#2e353d] border border-[#00d4ff]/30 flex items-center justify-center text-[#a8e8ff] font-bold">
                      {s.step}
                    </div>
                    <div>
                      <h4 className="font-bold text-lg mb-2">{s.title}</h4>
                      <p className="text-[#bbc9cf] text-sm">{s.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Code Block */}
            <div className="bg-[#080f16] rounded-xl border border-[#3c494e]/15 p-1 overflow-hidden shadow-2xl">
              <div className="flex items-center justify-between px-4 py-3 bg-[#2e353d]/50 border-b border-[#3c494e]/10">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/20" />
                  <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/20" />
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500/20" />
                </div>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-[#bbc9cf] hover:text-[#00d4ff] transition-colors"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="p-6 font-mono text-sm leading-relaxed overflow-x-auto">
                {CURL_LINES.map((line) => (
                  <div key={line.num} className="flex gap-4">
                    <span className="text-[#3c494e] select-none w-4 text-right">{line.num}</span>
                    <span>
                      {line.parts.map((p, i) => (
                        <span key={i} className={p.cls}>{p.text}</span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Resources */}
        <section className="px-6 py-20 max-w-7xl mx-auto">
          <h2 className="text-2xl font-black tracking-tight mb-12 flex items-center gap-3">
            <span className="w-1.5 h-6 bg-[#00d4ff]" />
            Developer Resources
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {[
              { title: 'API Documentation', desc: 'Complete endpoint references and authentication guides.', href: API_DOCS_URL, external: true },
              { title: 'OpenAPI Spec', desc: 'Download the JSON schema for local testing and generation.', href: OPENAPI_SPEC_URL, external: true },
              { title: 'Agent Integration', desc: 'Connect Arkova verification to your AI agent workflows.', href: '/AGENTS.md', external: true },
              { title: 'LLM Discovery', desc: 'Structured capability manifest for AI assistants.', href: '/llms.txt', external: true },
            ].map((r) => (
              <a
                key={r.title}
                href={r.href}
                target={r.external ? '_blank' : undefined}
                rel={r.external ? 'noopener noreferrer' : undefined}
                className="group p-6 bg-[#192028] rounded-lg border border-transparent hover:border-[#00d4ff]/20 transition-all"
              >
                <h4 className="font-bold mb-2 group-hover:text-[#a8e8ff] transition-colors">{r.title}</h4>
                <p className="text-[#bbc9cf] text-xs mb-4">{r.desc}</p>
                <ArrowRight className="h-5 w-5 text-[#a8e8ff]" />
              </a>
            ))}
          </div>
        </section>

        {/* MCP Server */}
        <section className="px-6 py-20 max-w-5xl mx-auto">
          <div className="relative p-8 md:p-12 rounded-xl border border-[#3c494e]/15 overflow-hidden" style={{ background: 'rgba(46, 53, 61, 0.4)', backdropFilter: 'blur(20px)' }}>
            <div className="absolute top-0 right-0 p-8 opacity-10">
              <Bot className="h-32 w-32" strokeWidth={1} />
            </div>
            <div className="relative z-10">
              <div className="inline-block px-3 py-1 bg-[#00d4ff]/10 border border-[#00d4ff]/30 rounded-lg mb-6">
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#a8e8ff]">
                  Beta Feature
                </span>
              </div>
              <h2 className="text-3xl font-black tracking-tight mb-4">MCP Server for AI Agents</h2>
              <p className="text-[#bbc9cf] mb-10 max-w-xl">
                Empower your AI agents with direct access to Arkova&apos;s verification suite through the Model Context Protocol.
              </p>
              <div className="grid md:grid-cols-2 gap-6">
                <div className="p-6 bg-[#2e353d] rounded-lg border-l-4 border-[#00d4ff]">
                  <code className="font-mono text-[#a8e8ff] font-bold block mb-2">verify_credential</code>
                  <p className="text-xs text-[#bbc9cf]">Verify any credential by its public ID and receive full cryptographic proof.</p>
                </div>
                <div className="p-6 bg-[#2e353d] rounded-lg border-l-4 border-[#00d4ff]">
                  <code className="font-mono text-[#a8e8ff] font-bold block mb-2">search_credentials</code>
                  <p className="text-xs text-[#bbc9cf]">Search the public credential registry by issuer, type, or metadata attributes.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* API Requirements + Rate Limits */}
        <section className="px-6 py-20 bg-[#151c24]">
          <div className="max-w-7xl mx-auto">
            <h2 className="text-2xl font-black tracking-tight mb-12 flex items-center gap-3">
              <span className="w-1.5 h-6 bg-[#00d4ff]" />
              API Reference
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              {/* Requirements */}
              <div className="bg-[#192028] p-8 rounded-lg border border-[#3c494e]/15">
                <div className="flex items-center gap-3 mb-6">
                  <Building2 className="h-6 w-6 text-[#a8e8ff]" />
                  <h3 className="text-lg font-bold">Requirements</h3>
                </div>
                <div className="space-y-4 text-sm text-[#bbc9cf]">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
                    <p>
                      <strong className="text-[#dce3ed]">Organization account required.</strong> API keys can only be
                      created by users with the Organization role. Individual accounts do not have API access.
                    </p>
                  </div>
                  <p>To get started: Sign up → Select &quot;Organization&quot; during onboarding → Navigate to Settings → API Keys.</p>
                </div>
              </div>

              {/* Rate Limits */}
              <div className="bg-[#192028] p-8 rounded-lg border border-[#3c494e]/15">
                <div className="flex items-center gap-3 mb-6">
                  <Gauge className="h-6 w-6 text-[#a8e8ff]" />
                  <h3 className="text-lg font-bold">Rate Limits</h3>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-[#bbc9cf]">Anonymous</span>
                    <code className="text-[#00d4ff] font-mono">100 req/min/IP</code>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-[#bbc9cf]">API Key</span>
                    <code className="text-[#00d4ff] font-mono">1,000 req/min</code>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-[#bbc9cf]">Batch Verification</span>
                    <code className="text-[#00d4ff] font-mono">10 req/min</code>
                  </div>
                  <p className="text-xs text-[#bbc9cf] pt-2">
                    Rate limit headers (<code className="text-[#a8e8ff]">X-RateLimit-*</code>) included on every response. Exceeding limits returns <code className="text-[#a8e8ff]">429</code> with <code className="text-[#a8e8ff]">Retry-After</code>.
                  </p>
                </div>
              </div>

              {/* Error Handling */}
              <div className="bg-[#192028] p-8 rounded-lg border border-[#3c494e]/15">
                <div className="flex items-center gap-3 mb-6">
                  <Key className="h-6 w-6 text-[#a8e8ff]" />
                  <h3 className="text-lg font-bold">Authentication & Errors</h3>
                </div>
                <div className="space-y-3 text-sm text-[#bbc9cf]">
                  <p>All requests use <code className="text-[#a8e8ff]">Authorization: Bearer &lt;api_key&gt;</code></p>
                  <div className="space-y-1.5 font-mono text-xs">
                    <div className="flex gap-3"><span className="text-emerald-400">200</span> <span>Success</span></div>
                    <div className="flex gap-3"><span className="text-amber-400">400</span> <span>Validation error (see <code>details</code> array)</span></div>
                    <div className="flex gap-3"><span className="text-red-400">401</span> <span>Invalid or missing API key</span></div>
                    <div className="flex gap-3"><span className="text-red-400">403</span> <span>Insufficient permissions</span></div>
                    <div className="flex gap-3"><span className="text-red-400">404</span> <span>Resource not found</span></div>
                    <div className="flex gap-3"><span className="text-orange-400">429</span> <span>Rate limit exceeded</span></div>
                    <div className="flex gap-3"><span className="text-red-400">500</span> <span>Internal server error</span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-[#bbc9cf]/15">
        <div className="max-w-7xl mx-auto py-12 px-6 flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex flex-col gap-2">
            <div className="text-sm font-bold text-[#bbc9cf]">Arkova</div>
            <div className="font-mono text-xs text-[#bbc9cf]">Secure document verification platform.</div>
          </div>
          <div className="flex flex-wrap justify-center gap-6">
            <Link to="/privacy" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">Privacy Policy</Link>
            <Link to="/terms" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">Terms of Service</Link>
            <Link to="/contact" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">Contact</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
