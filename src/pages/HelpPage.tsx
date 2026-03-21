/**
 * Help Page
 *
 * Help center with FAQ and support contact.
 *
 * @see P3-TS-03
 */

import { Link, useNavigate } from 'react-router-dom';
import {
  HelpCircle,
  Shield,
  FileText,
  Eye,
  Lock,
  ExternalLink,
  Mail,
  Code2,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/routes';
import { NAV_LABELS, DEVELOPER_PAGE_LABELS } from '@/lib/copy';

const FAQ_ITEMS = [
  {
    icon: Shield,
    question: 'How does document securing work?',
    answer:
      'When you upload a document, a unique cryptographic fingerprint is computed in your browser. This fingerprint is then permanently anchored, creating a tamper-proof record that proves the document existed at a specific point in time. Your document never leaves your device.',
  },
  {
    icon: FileText,
    question: 'What types of documents can I secure?',
    answer:
      'You can secure any file type — PDFs, images, spreadsheets, contracts, certificates, and more. The fingerprint is computed from the file contents, so the format does not matter.',
  },
  {
    icon: Eye,
    question: 'How does verification work?',
    answer:
      'Each secured record receives a unique verification ID. Anyone with the ID can verify the record status, issue date, and issuing organization without seeing the original document.',
  },
  {
    icon: Lock,
    question: 'Can a secured record be changed?',
    answer:
      'No. Once a document is secured, its fingerprint and anchor are immutable. The record can be revoked by the issuer, but the original anchoring data remains permanent.',
  },
] as const;

export function HelpPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <HelpCircle className="h-6 w-6 text-primary" />
          {NAV_LABELS.HELP}
        </h1>
        <p className="text-muted-foreground mt-1">
          Frequently asked questions and support
        </p>
      </div>

      <div className="space-y-6 max-w-2xl">
        {/* FAQ */}
        <div className="space-y-4">
          {FAQ_ITEMS.map(({ icon: Icon, question, answer }) => (
            <Card key={question}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Icon className="h-4 w-4 text-primary shrink-0" />
                  {question}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground leading-relaxed">{answer}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Developers */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Code2 className="h-5 w-5" />
              {DEVELOPER_PAGE_LABELS.HERO_TITLE}
            </CardTitle>
            <CardDescription>
              {DEVELOPER_PAGE_LABELS.HERO_SUBTITLE}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" asChild>
              <Link to={ROUTES.DEVELOPERS}>
                <ExternalLink className="mr-2 h-4 w-4" />
                View Developer Resources
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* Contact */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Contact Support
            </CardTitle>
            <CardDescription>
              Need more help? Reach out to our team.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" asChild>
              <a href="mailto:support@arkova.ai">
                <ExternalLink className="mr-2 h-4 w-4" />
                support@arkova.ai
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
