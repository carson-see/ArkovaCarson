/**
 * Developers Page — Synthetic Sentinel Design
 *
 * Public-facing developer platform page built from Stitch wireframe.
 * Showcases the Verification API, AI Intelligence endpoints, and MCP server.
 * No authentication required.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { usePageMeta } from '@/hooks/usePageMeta';
import { ShieldCheck, Layers, Brain, ArrowRight, Copy, Check, Bot, AlertCircle, Building2, Key, Gauge, CreditCard, Terminal, DollarSign, Code2 } from 'lucide-react';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { ROUTES } from '@/lib/routes';
import { PUBLIC_API_URL } from '@/lib/workerClient';

const API_DOCS_URL = `${PUBLIC_API_URL}/api/docs`;
const OPENAPI_SPEC_URL = `${PUBLIC_API_URL}/api/docs/spec.json`;

const CURL_LINES = [
  { num: '1', parts: [{ text: 'curl', cls: 'text-[#a8e8ff]' }, { text: ' -X POST', cls: 'text-[#dce3ed]' }] },
  { num: '2', parts: [{ text: `  ${PUBLIC_API_URL}/api/v1/verify`, cls: 'text-[#bbc9cf]' }] },
  { num: '3', parts: [{ text: '  -H "Authorization: Bearer ', cls: 'text-[#bbc9cf]' }, { text: 'YOUR_API_KEY', cls: 'text-[#00d4ff]' }, { text: '"', cls: 'text-[#bbc9cf]' }] },
  { num: '4', parts: [{ text: '  -H "Content-Type: application/json"', cls: 'text-[#bbc9cf]' }] },
  { num: '5', parts: [{ text: "  -d '{", cls: 'text-[#bbc9cf]' }] },
  { num: '6', parts: [{ text: '    ', cls: '' }, { text: '"public_id"', cls: 'text-[#5fd6eb]' }, { text: ': ', cls: 'text-[#bbc9cf]' }, { text: '"abc123-def456"', cls: 'text-[#00d4ff]' }, { text: ',', cls: 'text-[#bbc9cf]' }] },
  { num: '7', parts: [{ text: '    ', cls: '' }, { text: '"ai_metadata"', cls: 'text-[#5fd6eb]' }, { text: ': ', cls: 'text-[#bbc9cf]' }, { text: 'true', cls: 'text-[#00d4ff]' }] },
  { num: '8', parts: [{ text: "  }'", cls: 'text-[#bbc9cf]' }] },
];

const CURL_RAW = `curl -X POST \\
  ${PUBLIC_API_URL}/api/v1/verify \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "public_id": "abc123-def456",
    "ai_metadata": true
  }'`;

const SDK_EXAMPLES = {
  curl: `curl -X GET \\
  ${PUBLIC_API_URL}/api/v1/verify/abc123-def456 \\
  -H "Authorization: Bearer YOUR_API_KEY"`,
  typescript: `import { ArkovaClient } from '@arkova/sdk';

const client = new ArkovaClient({ apiKey: 'YOUR_API_KEY' });
const result = await client.verify('abc123-def456');
console.log(result.status); // 'ACTIVE'`,
  python: `from arkova import ArkovaClient

client = ArkovaClient(api_key="YOUR_API_KEY")
result = client.verify("abc123-def456")
print(result.status)  # "ACTIVE"`,
};

const PRICING_TABLE = [
  { endpoint: '/verify/:publicId', method: 'GET', price: '$0.002', desc: 'Verify credential' },
  { endpoint: '/verify/batch', method: 'POST', price: '$0.002/item', desc: 'Batch verification' },
  { endpoint: '/verify/entity', method: 'GET', price: '$0.005', desc: 'Entity lookup' },
  { endpoint: '/compliance/check', method: 'GET', price: '$0.010', desc: 'Compliance check' },
  { endpoint: '/regulatory/lookup', method: 'GET', price: '$0.002', desc: 'Regulatory lookup' },
  { endpoint: '/cle/*', method: 'GET/POST', price: '$0.005', desc: 'CLE verification' },
  { endpoint: '/ai/search', method: 'POST', price: '$0.010', desc: 'AI semantic search' },
  { endpoint: '/nessie/query', method: 'GET', price: '$0.010', desc: 'Nessie AI query' },
];

const CTA_BUTTON_CLASS = "bg-[#00d4ff] text-[#003642] text-xs uppercase tracking-widest px-6 py-2.5 rounded-full font-bold shadow-[0_0_15px_rgba(0,212,255,0.3)] hover:shadow-[0_0_25px_rgba(0,212,255,0.5)] transition-all";

export function DevelopersPage() {
  const { user } = useAuth();
  usePageMeta({
    title: 'Arkova Developer Platform — Verification API, SDKs & MCP Server',
    description: 'Build with the Arkova Verification API. Programmatic credential verification, AI metadata extraction, batch processing, and MCP server for AI agents.',
  });
  const [copied, setCopied] = useState(false);
  const [sdkTab, setSdkTab] = useState<'curl' | 'typescript' | 'python'>('curl');
  const [sdkCopied, setSdkCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(CURL_RAW);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSdkCopy = async () => {
    await navigator.clipboard.writeText(SDK_EXAMPLES[sdkTab]);
    setSdkCopied(true);
    setTimeout(() => setSdkCopied(false), 2000);
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
          <Link
            to={ROUTES.API_SANDBOX}
            className="text-[#bbc9cf] font-bold tracking-tight text-sm hover:text-[#a8e8ff] transition-colors"
          >
            Sandbox
          </Link>
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
          {user ? (
            <Link
              to={ROUTES.DASHBOARD}
              className={CTA_BUTTON_CLASS}
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link
                to={ROUTES.LOGIN}
                className="text-xs uppercase tracking-wider text-[#bbc9cf] hover:text-[#00d4ff] transition-all font-semibold"
              >
                Sign In
              </Link>
              <Link
                to={ROUTES.SIGNUP}
                className={CTA_BUTTON_CLASS}
              >
                Get Started
              </Link>
            </>
          )}
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
            {/* GEO-16: Social proof metrics */}
            <div className="flex flex-wrap justify-center gap-8 mt-12 text-center">
              <div>
                <p className="text-2xl font-bold text-[#00d4ff]">1.39M+</p>
                <p className="text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf]">Credentials Secured</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-[#00d4ff]">320K+</p>
                <p className="text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf]">Public Records</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-[#00d4ff]">21</p>
                <p className="text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf]">Credential Types</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-[#00d4ff]">87.2%</p>
                <p className="text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf]">AI Extraction F1</p>
              </div>
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
                  { step: '2', title: 'Generate API Keys', desc: 'Navigate to Settings → API Keys in the dashboard. Keys use Bearer authentication with HMAC-SHA256 security.' },
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

        {/* x402 Micropayment Flow */}
        <section className="px-6 py-20 bg-[#0d141b]">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-2xl font-black tracking-tight mb-4 flex items-center gap-3">
              <span className="w-1.5 h-6 bg-[#00d4ff]" />
              How x402 Payments Work
            </h2>
            <p className="text-[#bbc9cf] mb-10 max-w-2xl">
              Pay-per-request with no subscription. Use USDC on Base L2 for sub-cent micropayments.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              {[
                { step: '1', title: 'Request', desc: 'Make an API request without auth' },
                { step: '2', title: 'Pricing', desc: 'Receive 402 Payment Required with pricing details' },
                { step: '3', title: 'Pay', desc: 'Transfer USDC on Base L2 to the provided address' },
                { step: '4', title: 'Prove', desc: 'Retry request with X-Payment header containing TX proof' },
                { step: '5', title: 'Done', desc: 'Receive your API response' },
              ].map((s, i) => (
                <div key={s.step} className="relative bg-[#192028] p-5 rounded-lg border border-[#3c494e]/15">
                  {i < 4 && (
                    <div className="hidden md:block absolute -right-3 top-1/2 -translate-y-1/2 text-[#3c494e] z-10">
                      <ArrowRight className="h-5 w-5" />
                    </div>
                  )}
                  <div className="w-8 h-8 rounded-full bg-[#2e353d] border border-[#00d4ff]/30 flex items-center justify-center text-[#a8e8ff] font-bold text-sm mb-3">
                    {s.step}
                  </div>
                  <h4 className="font-bold text-sm mb-1">{s.title}</h4>
                  <p className="text-xs text-[#bbc9cf]">{s.desc}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-4 text-xs text-[#bbc9cf]">
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-[#a8e8ff]" />
                <span>USDC on Base (L2)</span>
              </div>
              <span className="text-[#3c494e]">|</span>
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-[#a8e8ff]" />
                <span>Sub-cent per verification</span>
              </div>
              <span className="text-[#3c494e]">|</span>
              <span>No subscription needed</span>
            </div>
          </div>
        </section>

        {/* Endpoint & Pricing Table */}
        <section className="px-6 py-20 bg-[#151c24]">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-2xl font-black tracking-tight mb-10 flex items-center gap-3">
              <span className="w-1.5 h-6 bg-[#00d4ff]" />
              Endpoint Pricing
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-[#3c494e]/30">
                    <th className="pb-3 text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold">Endpoint</th>
                    <th className="pb-3 text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold">Method</th>
                    <th className="pb-3 text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold">Price</th>
                    <th className="pb-3 text-[10px] uppercase tracking-[0.2em] text-[#bbc9cf] font-semibold hidden sm:table-cell">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {PRICING_TABLE.map((row) => (
                    <tr key={row.endpoint} className="border-b border-[#3c494e]/10 hover:bg-[#192028] transition-colors">
                      <td className="py-3 font-mono text-sm text-[#a8e8ff]">{row.endpoint}</td>
                      <td className="py-3">
                        <span className={`text-xs font-mono font-bold px-2 py-0.5 rounded ${
                          row.method === 'GET' ? 'bg-emerald-500/20 text-emerald-400'
                            : row.method === 'POST' ? 'bg-blue-500/20 text-blue-400'
                            : 'bg-purple-500/20 text-purple-400'
                        }`}>
                          {row.method}
                        </span>
                      </td>
                      <td className="py-3 font-mono text-sm text-[#00d4ff] font-bold">{row.price}</td>
                      <td className="py-3 text-sm text-[#bbc9cf] hidden sm:table-cell">{row.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* SDK Code Examples */}
        <section className="px-6 py-20 bg-[#0d141b]">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-2xl font-black tracking-tight mb-10 flex items-center gap-3">
              <span className="w-1.5 h-6 bg-[#00d4ff]" />
              SDK Examples
            </h2>
            <div className="bg-[#080f16] rounded-xl border border-[#3c494e]/15 overflow-hidden shadow-2xl">
              <div className="flex items-center justify-between px-4 py-3 bg-[#2e353d]/50 border-b border-[#3c494e]/10">
                <div className="flex gap-1">
                  {(['curl', 'typescript', 'python'] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setSdkTab(tab)}
                      className={`px-4 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider transition-all ${
                        sdkTab === tab
                          ? 'bg-[#00d4ff]/15 text-[#00d4ff] border border-[#00d4ff]/30'
                          : 'text-[#bbc9cf] hover:text-[#a8e8ff]'
                      }`}
                    >
                      {tab === 'typescript' ? 'TypeScript' : tab === 'python' ? 'Python' : 'cURL'}
                    </button>
                  ))}
                </div>
                <button
                  onClick={handleSdkCopy}
                  className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-[#bbc9cf] hover:text-[#00d4ff] transition-colors"
                >
                  {sdkCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {sdkCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="p-6 font-mono text-sm text-[#a8e8ff] overflow-x-auto whitespace-pre leading-relaxed">
                {SDK_EXAMPLES[sdkTab]}
              </pre>
            </div>
          </div>
        </section>

        {/* Try the API CTA */}
        <section className="px-6 py-16 bg-[#151c24]">
          <div className="max-w-3xl mx-auto text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#242b32] border border-[#3c494e]/20 mb-6">
              <Terminal className="h-3 w-3 text-[#00d4ff]" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-[#a8e8ff] font-semibold">
                Interactive Playground
              </span>
            </div>
            <h2 className="text-3xl font-black tracking-tight mb-4">Try the API</h2>
            <p className="text-[#bbc9cf] mb-8 max-w-lg mx-auto">
              Test every endpoint interactively. Configure parameters, send requests, and inspect responses — all from your browser.
            </p>
            <Link
              to={ROUTES.API_SANDBOX}
              className="inline-flex items-center gap-2 px-8 py-4 bg-[#00d4ff] text-[#003642] rounded-full font-bold uppercase tracking-widest text-sm hover:shadow-[0_0_30px_rgba(0,212,255,0.4)] transition-all"
            >
              <Code2 className="h-4 w-4" />
              Open API Sandbox
            </Link>
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

        {/* CLE API for State Bars */}
        <section className="px-6 py-20 bg-[#0d141b]">
          <div className="max-w-7xl mx-auto">
            <h2 className="text-2xl font-black tracking-tight mb-4 flex items-center gap-3">
              <span className="w-1.5 h-6 bg-[#00d4ff]" />
              CLE Verification API
            </h2>
            <p className="text-[#bbc9cf] mb-12 max-w-2xl">
              For state bars and CLE providers. Verify attorney compliance, submit course completions,
              and query CLE credit records — all anchored to an immutable network.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="bg-[#192028] p-6 rounded-lg border border-[#3c494e]/15">
                <code className="text-[#00d4ff] text-xs font-mono">GET</code>
                <h3 className="text-sm font-bold mt-2 mb-1">/api/v1/cle/verify</h3>
                <p className="text-xs text-[#bbc9cf]">Verify CLE compliance for a bar number against state requirements. Returns credit totals, compliance status, and anchored records.</p>
                <p className="text-[10px] text-[#859398] mt-3 font-mono">$0.005 / request</p>
              </div>
              <div className="bg-[#192028] p-6 rounded-lg border border-[#3c494e]/15">
                <code className="text-[#00d4ff] text-xs font-mono">GET</code>
                <h3 className="text-sm font-bold mt-2 mb-1">/api/v1/cle/credits</h3>
                <p className="text-xs text-[#bbc9cf]">List all anchored CLE credits for an attorney. Filter by jurisdiction and reporting period.</p>
                <p className="text-[10px] text-[#859398] mt-3 font-mono">$0.005 / request</p>
              </div>
              <div className="bg-[#192028] p-6 rounded-lg border border-[#3c494e]/15">
                <code className="text-[#a8e8ff] text-xs font-mono">POST</code>
                <h3 className="text-sm font-bold mt-2 mb-1">/api/v1/cle/submit</h3>
                <p className="text-xs text-[#bbc9cf]">Submit a CLE course completion for anchoring. Includes credit hours, category, provider, and jurisdiction.</p>
                <p className="text-[10px] text-[#859398] mt-3 font-mono">$0.005 / request</p>
              </div>
              <div className="bg-[#192028] p-6 rounded-lg border border-[#3c494e]/15">
                <code className="text-[#00d4ff] text-xs font-mono">GET</code>
                <h3 className="text-sm font-bold mt-2 mb-1">/api/v1/cle/requirements</h3>
                <p className="text-xs text-[#bbc9cf]">State-by-state CLE requirements reference. 15 jurisdictions with total hours, ethics hours, and reporting periods.</p>
                <p className="text-[10px] text-[#859398] mt-3 font-mono">Free</p>
              </div>
            </div>
          </div>
        </section>

      {/* Footer */}
      <footer className="border-t border-[#bbc9cf]/15">
        <div className="max-w-7xl mx-auto py-12 px-6 flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex flex-col gap-2">
            <div className="text-sm font-bold text-[#bbc9cf]">Arkova</div>
            <div className="font-mono text-xs text-[#bbc9cf]">Secure document verification platform.</div>
          </div>
          <nav className="flex flex-wrap justify-center gap-6" aria-label="Site navigation">
            <Link to="/about" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">About</Link>
            <Link to="/search" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">Search Credentials</Link>
            <Link to="/verify" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">Verify</Link>
            <Link to="/issuers" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">Verified Issuers</Link>
            <Link to="/cle" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">CLE API</Link>
            <Link to="/privacy" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">Privacy</Link>
            <Link to="/terms" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">Terms</Link>
            <Link to="/contact" className="font-mono text-xs text-[#bbc9cf] hover:text-[#00d4ff] underline transition-colors">Contact</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
