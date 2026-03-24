/**
 * Role Selector Component
 *
 * Allows new users to choose between Individual and Organization accounts.
 * This is a one-time decision that cannot be changed after selection.
 */

import { useState } from 'react';
import { User, Building2, ArrowRight, Loader2, CheckCircle, Upload, Sparkles, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ONBOARDING_VALUE_PROP_LABELS } from '@/lib/copy';

type RoleOption = 'INDIVIDUAL' | 'ORG_ADMIN';

interface RoleSelectorProps {
  onSelect: (role: RoleOption) => void;
  loading?: boolean;
}

export function RoleSelector({ onSelect, loading = false }: Readonly<RoleSelectorProps>) {
  const [selected, setSelected] = useState<RoleOption | null>(null);
  const [showValueProp, setShowValueProp] = useState(true);

  const handleContinue = () => {
    if (selected) {
      onSelect(selected);
    }
  };

  // Value proposition screen (Design Audit #7)
  if (showValueProp) {
    const steps = [
      { icon: Upload, title: ONBOARDING_VALUE_PROP_LABELS.STEP_1_TITLE, desc: ONBOARDING_VALUE_PROP_LABELS.STEP_1_DESC },
      { icon: Sparkles, title: ONBOARDING_VALUE_PROP_LABELS.STEP_2_TITLE, desc: ONBOARDING_VALUE_PROP_LABELS.STEP_2_DESC },
      { icon: Shield, title: ONBOARDING_VALUE_PROP_LABELS.STEP_3_TITLE, desc: ONBOARDING_VALUE_PROP_LABELS.STEP_3_DESC },
    ];
    return (
      <div className="space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">{ONBOARDING_VALUE_PROP_LABELS.TITLE}</h1>
        </div>
        <div className="space-y-4">
          {steps.map((step, i) => (
            <div key={step.title} className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <step.icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium">
                  <span className="text-primary mr-2">{i + 1}.</span>
                  {step.title}
                </p>
                <p className="text-sm text-muted-foreground mt-0.5">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
        <Button className="w-full" size="lg" onClick={() => setShowValueProp(false)}>
          {ONBOARDING_VALUE_PROP_LABELS.CONTINUE}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">Choose your account type</h1>
        <p className="text-muted-foreground">
          Select how you'll use Arkova to secure your documents
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Individual Option */}
        <Card
          className={cn(
            'cursor-pointer transition-all hover:border-primary/50',
            selected === 'INDIVIDUAL' && 'border-primary ring-2 ring-primary/20'
          )}
          onClick={() => !loading && setSelected('INDIVIDUAL')}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <User className="h-5 w-5 text-primary" />
              </div>
              {selected === 'INDIVIDUAL' && (
                <CheckCircle className="h-5 w-5 text-primary" />
              )}
            </div>
            <CardTitle className="mt-4">Individual</CardTitle>
            <CardDescription>Personal document security</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span>Secure personal documents</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span>Private vault access</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span>Simple verification</span>
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* Organization Option */}
        <Card
          className={cn(
            'cursor-pointer transition-all hover:border-primary/50',
            selected === 'ORG_ADMIN' && 'border-primary ring-2 ring-primary/20'
          )}
          onClick={() => !loading && setSelected('ORG_ADMIN')}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <Building2 className="h-5 w-5 text-primary" />
              </div>
              {selected === 'ORG_ADMIN' && (
                <CheckCircle className="h-5 w-5 text-primary" />
              )}
            </div>
            <CardTitle className="mt-4">Organization</CardTitle>
            <CardDescription>Business document security</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span>Team collaboration</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span>Organization-wide vault</span>
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                <span>Member management</span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <Button
        className="w-full"
        size="lg"
        onClick={handleContinue}
        disabled={!selected || loading}
      >
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Setting up...
          </>
        ) : (
          <>
            Continue
            <ArrowRight className="ml-2 h-4 w-4" />
          </>
        )}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        This selection cannot be changed later
      </p>
    </div>
  );
}
