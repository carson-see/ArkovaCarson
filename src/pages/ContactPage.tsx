/**
 * Contact Page
 *
 * Public route at /contact. Shows support contact information.
 */

import { Link } from 'react-router-dom';
import { Shield, Mail, MessageSquare } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ContactPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-4">
          <Link to="/" className="flex items-center gap-2 text-foreground hover:opacity-80 transition-opacity">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            <span className="font-semibold">Arkova</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Contact Us</h1>
        <p className="text-muted-foreground mb-8">
          Have a question or need help? Reach out and we will get back to you.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 mb-2">
                <Mail className="h-5 w-5 text-primary" />
              </div>
              <CardTitle className="text-base">General Support</CardTitle>
              <CardDescription>Questions about your account, billing, or features</CardDescription>
            </CardHeader>
            <CardContent>
              <a
                href="mailto:support@arkova.io"
                className="text-sm font-medium text-primary hover:underline"
              >
                support@arkova.io
              </a>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 mb-2">
                <MessageSquare className="h-5 w-5 text-primary" />
              </div>
              <CardTitle className="text-base">Enterprise Inquiries</CardTitle>
              <CardDescription>Custom plans, API access, and integrations</CardDescription>
            </CardHeader>
            <CardContent>
              <a
                href="mailto:enterprise@arkova.io"
                className="text-sm font-medium text-primary hover:underline"
              >
                enterprise@arkova.io
              </a>
            </CardContent>
          </Card>
        </div>

        <div className="mt-12 rounded-lg border bg-muted/50 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Arkova is based in the United States. We typically respond within one business day.
          </p>
        </div>
      </main>
      <footer className="border-t">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4 text-xs text-muted-foreground">
          <span>&copy; {new Date().getFullYear()} Arkova</span>
          <nav className="flex gap-4">
            <Link to="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
            <Link to="/terms" className="hover:text-foreground transition-colors">Terms</Link>
            <Link to="/contact" className="hover:text-foreground transition-colors font-medium">Contact</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
