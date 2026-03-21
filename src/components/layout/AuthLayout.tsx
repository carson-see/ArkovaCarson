/**
 * Auth Layout Component
 *
 * Provides consistent layout for authentication pages.
 * Clean, professional design inspired by modern SaaS patterns.
 */

import { Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface AuthLayoutProps {
  children: React.ReactNode;
  title: string;
  description: string;
}

export function AuthLayout({ children, title, description }: Readonly<AuthLayoutProps>) {
  // Auth pages now respect the user's theme preference (dark mode default).
  // BUG-001 force-light workaround removed — no longer needed since the app
  // defaults to dark and public/auth routes all support dark mode.

  return (
    <div className="min-h-screen flex flex-col bg-[#0d141b]">
      {/* Background with cyan glow */}
      <div className="fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[#0d141b]" />
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-[#00d4ff]/5 rounded-full blur-3xl" />
      </div>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          {/* Logo and branding */}
          <div className="flex flex-col items-center text-center">
            <div className="mb-4">
              <ArkovaLogo size={56} />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-[#dce3ed]">
              Arkova
            </h1>
            <p className="mt-1 text-sm text-[#859398]">
              Secure document verification
            </p>
          </div>

          {/* Auth card */}
          <Card className="bg-[#2e353d]/40 backdrop-blur-xl border border-white/5 shadow-lg">
            <CardHeader className="space-y-1 pb-4">
              <CardTitle className="text-xl font-semibold text-center text-[#dce3ed]">
                {title}
              </CardTitle>
              <CardDescription className="text-center text-[#bbc9cf]">
                {description}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {children}
            </CardContent>
          </Card>

          {/* Footer */}
          <p className="text-center text-xs text-[#859398]">
            By continuing, you agree to our{' '}
            <Link to="/terms" className="underline underline-offset-4 hover:text-[#00d4ff] transition-colors">
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link to="/privacy" className="underline underline-offset-4 hover:text-[#00d4ff] transition-colors">
              Privacy Policy
            </Link>
          </p>
        </div>
      </main>

      {/* Trust indicators */}
      <footer className="py-6 text-center">
        <div className="flex items-center justify-center gap-6 text-xs text-[#859398]">
          <span className="flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            Enterprise-grade security
          </span>
          <span className="hidden sm:inline text-[#3c494e]">|</span>
          <span className="hidden sm:block">Preparing for SOC 2</span>
        </div>
      </footer>
    </div>
  );
}
