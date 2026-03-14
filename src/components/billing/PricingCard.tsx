/**
 * Pricing Card Component
 *
 * Displays a subscription plan with gradient borders and elevated recommended state.
 * Uses approved terminology per Constitution.
 */

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface PricingPlan {
  id: string;
  name: string;
  description: string;
  price: number | null;
  priceLabel?: string;
  period: 'month' | 'year' | 'custom';
  features: string[];
  recordsIncluded: number | 'unlimited';
  recommended?: boolean;
  current?: boolean;
}

interface PricingCardProps {
  plan: PricingPlan;
  onSelect?: (planId: string) => void;
  loading?: boolean;
}

export function PricingCard({ plan, onSelect, loading }: Readonly<PricingCardProps>) {
  return (
    <Card
      className={cn(
        'relative flex flex-col shadow-card-rest hover:shadow-card-hover transition-all duration-300 hover:-translate-y-1',
        plan.recommended && 'gradient-border shadow-glow-md',
        plan.current && 'border-success'
      )}
    >
      {plan.recommended && (
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 text-[0.65rem] font-semibold tracking-wide shadow-glow-sm">
          Recommended
        </Badge>
      )}
      {plan.current && (
        <Badge variant="success" className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 text-[0.65rem] font-semibold tracking-wide">
          Current Plan
        </Badge>
      )}

      <CardHeader className="text-center pb-2 pt-7">
        <CardTitle className="text-heading-sm tracking-tight">{plan.name}</CardTitle>
        <CardDescription className="text-xs">{plan.description}</CardDescription>
      </CardHeader>

      <CardContent className="flex-1">
        {/* Price */}
        <div className="text-center mb-8">
          {plan.price === null ? (
            <div className="text-heading-lg font-bold tracking-tight">{plan.priceLabel || 'Contact us'}</div>
          ) : (
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-display font-bold tracking-tight">${plan.price}</span>
              {plan.period !== 'custom' && (
                <span className="text-sm text-muted-foreground font-medium">
                  /{plan.period === 'month' ? 'mo' : 'yr'}
                </span>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2 font-medium">
            {plan.recordsIncluded === 'unlimited'
              ? 'Unlimited records'
              : `${plan.recordsIncluded} records/month`}
          </p>
        </div>

        {/* Features */}
        <ul className="space-y-3">
          {plan.features.map((feature, index) => (
            <li key={`${feature}-${index}`} className="flex items-start gap-2.5">
              <div className="flex h-5 w-5 items-center justify-center rounded-full bg-success/10 shrink-0 mt-0.5">
                <Check className="h-3 w-3 text-success" />
              </div>
              <span className="text-sm leading-snug">{feature}</span>
            </li>
          ))}
        </ul>
      </CardContent>

      <CardFooter className="pt-4">
        <Button
          className={cn(
            'w-full h-11 font-semibold transition-all duration-300',
            plan.recommended && !plan.current && 'shadow-glow-sm hover:shadow-glow-md'
          )}
          variant={plan.current ? 'outline' : (plan.recommended ? 'default' : 'secondary')}
          onClick={() => onSelect?.(plan.id)}
          disabled={loading || plan.current}
        >
          {plan.current ? 'Current Plan' : (plan.price === null ? 'Contact Sales' : 'Select Plan')}
        </Button>
      </CardFooter>
    </Card>
  );
}

// Pre-defined plans matching the documentation
export const PRICING_PLANS: PricingPlan[] = [
  {
    id: 'individual',
    name: 'Individual',
    description: 'For personal document security',
    price: 10,
    period: 'month',
    recordsIncluded: 10,
    features: [
      'Secure up to 10 records per month',
      'Document verification',
      'Basic support',
      'Proof downloads',
    ],
  },
  {
    id: 'professional',
    name: 'Professional',
    description: 'For growing businesses',
    price: 100,
    period: 'month',
    recordsIncluded: 100,
    recommended: true,
    features: [
      'Secure up to 100 records per month',
      'Document verification',
      'Priority support',
      'Proof downloads',
      'Bulk CSV upload',
      'API access',
    ],
  },
  {
    id: 'organization',
    name: 'Organization',
    description: 'For enterprise teams',
    price: null,
    priceLabel: 'Custom',
    period: 'custom',
    recordsIncluded: 'unlimited',
    features: [
      'Unlimited records',
      'Document verification',
      'Dedicated support',
      'Proof downloads',
      'Bulk CSV upload',
      'API access',
      'Team management',
      'Custom integrations',
      'SLA guarantee',
    ],
  },
];
