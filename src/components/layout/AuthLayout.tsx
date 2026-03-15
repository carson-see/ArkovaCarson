/**
 * Auth Layout Component
 *
 * Bold, atmospheric authentication layout with mesh gradient background,
 * floating decorative elements, and refined card presentation.
 */

import { Shield, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ArkovaLogo } from '@/components/layout/ArkovaLogo';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface AuthLayoutProps {
  children: React.ReactNode;
  title: string;
  description: string;
}

export function AuthLayout({ children, title, description }: Readonly<AuthLayoutProps>) {
  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Atmospheric background */}
      <div className="fixed inset-0 -z-10 bg-mesh-gradient" />

      {/* Geometric pattern overlay */}
      <div className="fixed inset-0 -z-10 bg-dot-pattern opacity-[0.35]" />

      {/* Decorative floating orbs */}
      <div className="fixed top-[15%] left-[8%] w-72 h-72 rounded-full bg-primary/[0.04] blur-3xl animate-float pointer-events-none" />
      <div className="fixed bottom-[20%] right-[10%] w-96 h-96 rounded-full bg-success/[0.03] blur-3xl animate-float-delayed pointer-events-none" />
      <div className="fixed top-[60%] left-[60%] w-48 h-48 rounded-full bg-accent/[0.04] blur-2xl animate-float-slow pointer-events-none" />

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-[420px] space-y-8">
          {/* Logo and branding */}
          <div className="flex flex-col items-center text-center animate-in-view stagger-1">
            <div className="mb-5 relative">
              <div className="absolute inset-0 scale-150 bg-primary/10 rounded-full blur-xl" />
              <ArkovaLogo size={52} className="relative" />
            </div>
            <h1 className="text-display font-bold tracking-tight text-foreground">
              Arkova
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground font-medium">
              Secure document verification
            </p>
          </div>

          {/* Auth card with gradient border */}
          <Card className="border-0 shadow-glow-md gradient-border animate-in-view stagger-2">
            <CardHeader className="space-y-1.5 pb-5 pt-7">
              <CardTitle className="text-heading-sm font-semibold text-center tracking-tight">
                {title}
              </CardTitle>
              <CardDescription className="text-center text-sm">
                {description}
              </CardDescription>
            </CardHeader>
            <CardContent className="pb-7">
              {children}
            </CardContent>
          </Card>

          {/* Footer */}
          <p className="text-center text-xs text-muted-foreground animate-in-view stagger-3">
            By continuing, you agree to our{' '}
            <Link to="/terms" className="font-medium underline underline-offset-4 hover:text-primary transition-colors duration-200">
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link to="/privacy" className="font-medium underline underline-offset-4 hover:text-primary transition-colors duration-200">
              Privacy Policy
            </Link>
          </p>
        </div>
      </main>

      {/* Trust indicators */}
      <footer className="py-6 text-center animate-in-view stagger-4">
        <div className="flex items-center justify-center gap-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Shield className="h-3.5 w-3.5 text-primary/60" />
            Enterprise-grade security
          </span>
          <span className="hidden sm:inline text-border">|</span>
          <span className="hidden sm:flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-primary/60" />
            Preparing for SOC 2
          </span>
        </div>
      </footer>
    </div>
  );
}
