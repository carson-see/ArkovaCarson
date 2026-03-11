/**
 * Auth Layout Component
 *
 * Provides consistent layout for authentication pages.
 * Clean, professional design inspired by modern SaaS patterns.
 */

import { Shield } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface AuthLayoutProps {
  children: React.ReactNode;
  title: string;
  description: string;
}

export function AuthLayout({ children, title, description }: Readonly<AuthLayoutProps>) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Background with subtle gradient */}
      <div className="fixed inset-0 -z-10 bg-gradient-to-br from-slate-50 via-white to-blue-50" />

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-md space-y-8">
          {/* Logo and branding */}
          <div className="flex flex-col items-center text-center">
            <div className="flex items-center justify-center h-14 w-14 rounded-xl bg-primary/10 mb-4">
              <Shield className="h-8 w-8 text-primary" />
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Arkova
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Secure document verification
            </p>
          </div>

          {/* Auth card */}
          <Card className="border-0 shadow-lg shadow-slate-200/50">
            <CardHeader className="space-y-1 pb-4">
              <CardTitle className="text-xl font-semibold text-center">
                {title}
              </CardTitle>
              <CardDescription className="text-center">
                {description}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {children}
            </CardContent>
          </Card>

          {/* Footer */}
          <p className="text-center text-xs text-muted-foreground">
            By continuing, you agree to our{' '}
            <a href="/terms" className="underline underline-offset-4 hover:text-primary transition-colors">
              Terms of Service
            </a>{' '}
            and{' '}
            <a href="/privacy" className="underline underline-offset-4 hover:text-primary transition-colors">
              Privacy Policy
            </a>
          </p>
        </div>
      </main>

      {/* Trust indicators */}
      <footer className="py-6 text-center">
        <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            Enterprise-grade security
          </span>
          <span className="hidden sm:inline">|</span>
          <span className="hidden sm:block">Preparing for SOC 2</span>
        </div>
      </footer>
    </div>
  );
}
