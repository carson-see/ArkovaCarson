/**
 * API Sandbox Page — Public interactive API testing playground
 *
 * No authentication required. Wraps the ApiSandbox component
 * in the Synthetic Sentinel design system page layout.
 */

import { Link } from 'react-router-dom';
import { ArrowLeft, Terminal } from 'lucide-react';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { ApiSandbox } from '@/components/api/ApiSandbox';
import { ROUTES } from '@/lib/routes';

export function ApiSandboxPage() {
  return (
    <div className="min-h-screen bg-[#0d141b] text-[#dce3ed] selection:bg-[#00d4ff] selection:text-[#003642]">
      {/* Header */}
      <header className="fixed top-0 z-50 w-full bg-[#0d141b]/95 backdrop-blur-sm border-b border-[#3c494e]/15 px-6 py-4 flex justify-between items-center">
        <Link to={ROUTES.SEARCH} className="flex items-center gap-2">
          <ArkovaLogo size={32} />
          <span className="text-xl font-black text-[#00d4ff] tracking-tighter">Arkova</span>
        </Link>
        <nav className="hidden md:flex items-center gap-8">
          <Link
            to={ROUTES.DEVELOPERS}
            className="text-[#bbc9cf] font-bold tracking-tight text-sm hover:text-[#a8e8ff] transition-colors"
          >
            Docs
          </Link>
          <span className="text-[#00d4ff] border-b-2 border-[#00d4ff] pb-1 font-bold tracking-tight text-sm">
            Sandbox
          </span>
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

      <main className="pt-24 pb-20 px-6">
        <div className="max-w-4xl mx-auto">
          {/* Breadcrumb */}
          <Link
            to={ROUTES.DEVELOPERS}
            className="inline-flex items-center gap-2 text-sm text-[#bbc9cf] hover:text-[#00d4ff] transition-colors mb-8"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Developer Platform
          </Link>

          {/* Title */}
          <div className="mb-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#242b32] border border-[#3c494e]/20 mb-6">
              <Terminal className="h-3 w-3 text-[#00d4ff]" />
              <span className="text-[10px] uppercase tracking-[0.2em] text-[#a8e8ff] font-semibold">
                Interactive Playground
              </span>
            </div>
            <h1 className="text-4xl md:text-5xl font-black tracking-tighter mb-4">
              API{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-br from-[#a8e8ff] to-[#00d4ff]">
                Sandbox
              </span>
            </h1>
            <p className="text-[#bbc9cf] text-lg max-w-2xl">
              Test a curated set of Arkova API endpoints. Select an endpoint, configure parameters, and inspect the response directly in your browser. Use the live OpenAPI reference for the complete surface.
            </p>
          </div>

          {/* Sandbox */}
          <div className="bg-[#151c24] border border-[#3c494e]/15 rounded-xl p-6 md:p-8">
            <ApiSandbox />
          </div>
        </div>
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
